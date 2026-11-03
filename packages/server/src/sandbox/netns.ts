import { Effect } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { InternalError } from "@cloudagents/protocol"
import { busEnv, scopeArgs, type SystemdSettings } from "./systemd"

/**
 * One namespace holder per task, shared by every sandbox of that task that uses the task desktop (agent run,
 * workspace_exec, desktop apps). The holder gives the task its own IPC and mount namespaces; the mount namespace has a
 * private, empty `/tmp/.X11-unix` (a tmpfs), so the X server's socket directory is never the host's, which works even
 * where the host's is read-only (WSLg mounts it so). The task's X server and capture join the IPC and mount namespaces
 * too (`joinTaskDesktop`), which lets X clients share MIT-SHM images with the server without seeing another task's
 * segments.
 *
 * `strict` holders are `pasta`'s: a user + network namespace with outbound internet through user-space NAT, so a
 * browser on the task desktop reaches the agent's dev server on localhost (`joinTaskNet` joins it too). `basic` and
 * `off` holders are bwrap's and have no network namespace: those levels share the host's network. Inside a strict
 * holder, loopback is the task's own: host services on 127.0.0.1 and other X servers' abstract sockets are out of reach.
 * The one way back to the host is the box port, forwarded with `-T` (broker and MCP). `--no-map-gw` keeps pasta from
 * mapping its gateway address to the host's loopback.
 */

const X11_DIR = "/tmp/.X11-unix"

/** Tools the pasta holder is started with; the util-linux ones come from one package. */
interface PastaTools {
  /** `unshare` (util-linux): gives the holder its own IPC and mount namespaces, inside pasta's user + network namespace. */
  readonly unsharePath: string
  /** util-linux `mount`: mounts the holder's private /tmp/.X11-unix. The PATH one may be NixOS's setuid wrapper, which a user namespace cannot run. */
  readonly mountPath: string
  /** `sh`, to run the mount before the holder execs sleep. */
  readonly shPath: string
  /** `sleep`: the holder's process once the mount is done. */
  readonly sleepPath: string
}

/** How the task's holder is started. */
export type HolderStart =
  | (PastaTools & {
      readonly kind: "pasta"
      readonly pastaPath: string
      /** util-linux `umount`: unmounts the /proc pasta mounts in the holder (see `holderShell`). */
      readonly umountPath: string
      /** Box HTTP port forwarded into the namespace (broker and MCP at 127.0.0.1:<port>). */
      readonly boxPort: number
    })
  | {
      readonly kind: "bwrap"
      /** bwrap: gives the holder its own user, IPC and mount namespaces, and mounts its private /tmp/.X11-unix. */
      readonly bwrapPath: string
      /** `sleep`: the holder's process. */
      readonly sleepPath: string
      /** `sh`: writes the holder's readiness marker once bwrap has mounted its private /tmp/.X11-unix. */
      readonly shPath: string
    }

export interface TaskHolderOptions {
  readonly taskId: string
  readonly start: HolderStart
  /** With systemd, the holder lives in the task slice, so task removal and box restarts kill it. */
  readonly systemd: { readonly settings: SystemdSettings; readonly systemdRun: string } | null
}

interface TaskHolder {
  /** The process that starts the holder: pasta or bwrap, which forks the holder as its child. */
  readonly proc: ChildProcess
  /** Host pid of the holder; `nsenter --target` joins its namespaces. */
  readonly holder: number
}

const holders = new Map<string, TaskHolder>()

const START_TIMEOUT_MS = 5_000
const POLL_MS = 25

const alive = (h: TaskHolder): boolean => {
  if (h.proc.exitCode !== null || h.proc.signalCode !== null) return false
  try {
    process.kill(h.holder, 0)
    return true
  } catch {
    return false
  }
}

/** Host pid of the first child of `pid`: the holder, once pasta or bwrap has forked it. */
const holderPid = (pid: number): number | null => {
  try {
    const first = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(" ")[0]
    return first ? Number(first) : null
  } catch {
    return null
  }
}

/** pasta has finished configuring the namespace once it has a default route (`/proc/<pid>/net` is per netns). */
const configured = (holder: number): boolean => {
  try {
    return readFileSync(`/proc/${holder}/net/route`, "utf8")
      .split("\n")
      .some((line) => line.split("\t")[1] === "00000000")
  } catch {
    return false
  }
}

/**
 * The holder has mounted its private X socket directory and written the readiness marker into it, checked in the
 * holder's own view as `x11Dir` does. Only the holder writes it, after its tmpfs mount: until then the holder sees the
 * inherited WSLg tmpfs, which a mount table check cannot tell apart from a private one.
 */
const privateReady = (holder: number, markerPath: string): boolean => existsSync(`/proc/${holder}/root${markerPath}`)

const kill = (h: TaskHolder) => {
  for (const pid of [h.holder, h.proc.pid]) {
    if (pid === undefined) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

/**
 * Runs in a pasta holder: mounts its private X socket directory, writes the readiness marker there, then execs sleep so
 * the holder's pid stays the namespace's pid. pasta runs its command in a PID namespace of its own and mounts that
 * namespace's /proc over the host's. Processes that join the holder's mount namespace from outside cannot resolve
 * `/proc/self` through it (NVENC fails on that), so the holder unmounts it and joined processes see the host's /proc.
 */
const holderShell = (start: Extract<HolderStart, { kind: "pasta" }>, markerPath: string): string[] => [
  start.shPath,
  "-c",
  // The directory is a tmpfs owned by the holder's root (the box's uid, mapped), mode 1777 like /tmp, created if the host has none.
  `"$2" /proc && "$0" -t tmpfs -o mode=1777,X-mount.mkdir tmpfs ${X11_DIR} && : > "$3" && exec "$1" infinity`,
  start.mountPath,
  start.sleepPath,
  start.umountPath,
  markerPath,
]

const startHolder = async (opts: TaskHolderOptions): Promise<TaskHolder> => {
  const { start } = opts
  /** The holder's readiness marker, written by the holder once its private X socket directory is mounted. */
  const markerPath = `${X11_DIR}/.holder-ready-${randomUUID()}`
  const argv =
    start.kind === "pasta"
      ? [
          start.pastaPath,
          // pasta forwards ports automatically in both directions unless told otherwise: nothing inbound
          // (`-t`/`-u none`, so task servers are not published on the host) and only the box port outbound.
          "--config-net",
          "--no-map-gw",
          "-t",
          "none",
          "-u",
          "none",
          "-T",
          String(start.boxPort),
          "-U",
          "none",
          "-q",
          "-f",
          "--",
          start.unsharePath,
          "--ipc",
          "--mount",
          ...holderShell(start, markerPath),
        ]
      : [
          start.bwrapPath,
          // Its own user namespace, mapping the box user to itself, so the desktop's processes never see root: xterm
          // chowns its pty to root and the tty group only when it runs as root, and that group is unmapped in a
          // single-id namespace (chown fails with EINVAL, xterm exits). Root is not needed for the tmpfs: bwrap mounts
          // it without the mount binary's root check. The holder is bwrap's child: it writes the readiness marker
          // and execs sleep, so its pid stays the namespace's pid (as holderShell does for pasta).
          "--die-with-parent",
          "--unshare-user",
          "--unshare-ipc",
          "--bind",
          "/",
          "/",
          // A fresh bind of /dev: the bind of `/` keeps the host's `nodev`, and then opening /dev/null fails with EACCES.
          "--dev-bind",
          "/dev",
          "/dev",
          "--perms",
          "1777",
          "--tmpfs",
          X11_DIR,
          "--",
          start.shPath,
          "-c",
          ': > "$0" && exec "$1" infinity',
          markerPath,
          start.sleepPath,
        ]
  // systemd-run --scope execs in place, so the spawned pid is the holder's starter.
  const [file, args] = opts.systemd
    ? [opts.systemd.systemdRun, [...scopeArgs(opts.systemd.settings, opts.taskId, "holder"), ...argv]]
    : [argv[0] as string, argv.slice(1)]
  const proc = spawn(file, args, { env: { PATH: process.env.PATH ?? "", ...busEnv() }, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  let holder: number | null = null
  let readyHolder: number | null = null
  while (Date.now() < deadline && proc.exitCode === null) {
    holder = proc.pid === undefined ? null : holderPid(proc.pid)
    if (holder !== null && privateReady(holder, markerPath) && (start.kind === "bwrap" || configured(holder))) {
      readyHolder = holder
      break
    }
    await Bun.sleep(POLL_MS)
  }
  // The marker is the holder's alone: if the box sees it too, the holder's mount was not private.
  if (readyHolder !== null && !existsSync(markerPath)) {
    const started: TaskHolder = { proc, holder: readyHolder }
    proc.on("exit", () => {
      if (holders.get(opts.taskId) === started) holders.delete(opts.taskId)
    })
    return started
  }
  // The holder does not exit with its starter, so both are killed.
  proc.kill("SIGKILL")
  if (holder !== null) kill({ proc, holder })
  if (readyHolder !== null) {
    throw new Error(`${start.kind} holder's ${X11_DIR} is shared with the box: its private mount did not take`)
  }
  throw new Error(
    stderr.trim() ||
      (proc.exitCode === null
        ? `${start.kind} holder did not mount its private ${X11_DIR} within ${START_TIMEOUT_MS} ms`
        : `${start.kind} holder exited before mounting its private ${X11_DIR}`),
  )
}

/** In-flight starts, so concurrent launches of one task share a holder. */
const starting = new Map<string, Promise<TaskHolder>>()

/** Holder pid of the task's namespaces, starting the holder when there is none (or it died). */
export const ensureTaskHolder = (opts: TaskHolderOptions): Effect.Effect<number, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const existing = holders.get(opts.taskId)
      if (existing && alive(existing)) return existing.holder
      if (existing) stopTaskHolder(opts.taskId)
      let pending = starting.get(opts.taskId)
      if (!pending) {
        const start: Promise<TaskHolder> = startHolder(opts).then(
          (h) => {
            // A stop that ran during the start dropped this start: the holder it made must not outlive the task.
            if (starting.get(opts.taskId) !== start) {
              kill(h)
              throw new Error("the task was stopped while its namespace holder started")
            }
            starting.delete(opts.taskId)
            holders.set(opts.taskId, h)
            return h
          },
          (e: unknown) => {
            if (starting.get(opts.taskId) === start) starting.delete(opts.taskId)
            throw e
          },
        )
        starting.set(opts.taskId, start)
        pending = start
      }
      return (await pending).holder
    },
    catch: (e) => new InternalError({ message: `task namespace holder did not come up: ${e instanceof Error ? e.message : String(e)}` }),
  })

/** Argv prefix that runs the following command inside the task's namespaces (strict: network too) with the box user's own uid. */
export const joinTaskNet = (nsenterPath: string, holder: number): string[] => [
  nsenterPath,
  "--target",
  String(holder),
  "--user",
  "--net",
  "--ipc",
  "--mount",
  "--preserve-credentials",
  "--",
]

/**
 * Argv prefix for the task's X server and its box-side clients (capture, screenshots, input): the IPC and mount
 * namespaces of `target`, a process already in the task's (joining needs its user namespace). The mount namespace
 * holds the X socket directory. No network namespace is joined: a client keeps its launch's network (`joinTaskNet` adds it).
 */
export const joinTaskDesktop = (nsenterPath: string, target: number): string[] => [
  nsenterPath,
  "--target",
  String(target),
  "--user",
  "--ipc",
  "--mount",
  "--preserve-credentials",
  "--",
]

export const stopTaskHolder = (taskId: string): void => {
  starting.delete(taskId)
  const h = holders.get(taskId)
  if (!h) return
  holders.delete(taskId)
  kill(h)
}

export const stopAllTaskHolders = (): void => {
  for (const taskId of new Set([...holders.keys(), ...starting.keys()])) stopTaskHolder(taskId)
}

// Namespaces must not outlive the box, even when shutdown hooks never ran (systemd also stops the slice).
process.on("exit", stopAllTaskHolders)

import { Effect } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
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
 * `off` holders are bubblewrap's and have no network namespace: those levels share the host's network. Inside a strict
 * holder, loopback is the task's own: host services on 127.0.0.1 and other X servers' abstract sockets are out of reach.
 * The one way back to the host is the box port, forwarded with `-T` (broker and MCP). `--no-map-gw` keeps pasta from
 * mapping its gateway address to the host's loopback.
 */

const X11_DIR = "/tmp/.X11-unix"

/** How the task's holder is started. */
export type HolderStart =
  | {
      readonly kind: "pasta"
      readonly pastaPath: string
      /** Box HTTP port forwarded into the namespace (broker and MCP at 127.0.0.1:<port>). */
      readonly boxPort: number
      /** `sleep` from the sandbox toolchain. */
      readonly sleepPath: string
      /** `unshare` (util-linux): gives the holder its own IPC and mount namespaces. */
      readonly unsharePath: string
      /** util-linux `mount`: mounts the holder's private /tmp/.X11-unix. */
      readonly mountPath: string
      /** `sh` from the sandbox toolchain, to run the mount before the holder execs sleep. */
      readonly shPath: string
    }
  | {
      readonly kind: "bwrap"
      readonly bwrapPath: string
      readonly sleepPath: string
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

/** The holder's private X socket directory is mounted: a tmpfs, so a host bind mount there (WSLg) does not count. */
const mounted = (holder: number): boolean => {
  try {
    return readFileSync(`/proc/${holder}/mountinfo`, "utf8")
      .split("\n")
      .some((line) => {
        // Fields: id, parent, major:minor, root, mount point, options, optional fields, "-", fstype, source, options.
        const fields = line.split(" ")
        return fields[4] === X11_DIR && line.includes(" - tmpfs ")
      })
  } catch {
    return false
  }
}

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

const startHolder = async (opts: TaskHolderOptions): Promise<TaskHolder> => {
  const { start } = opts
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
          start.shPath,
          "-c",
          // The holder execs sleep, so its pid stays the namespace's pid. The X socket directory is a tmpfs owned by
          // the task's root (the box's uid, mapped), mode 1777 like /tmp, created if the host has none.
          `"$0" -t tmpfs -o mode=1777,X-mount.mkdir tmpfs ${X11_DIR} && exec "$1" infinity`,
          start.mountPath,
          start.sleepPath,
        ]
      : // bwrap's own IPC and mount namespaces over the host's root, which stays writable: the processes that join it
        // (the desktop, and basic and off launches) run there as they do on the host. The tmpfs replaces the host's X
        // directory. bwrap forks sleep, so the holder is bwrap's child.
        [
          start.bwrapPath,
          "--die-with-parent",
          "--unshare-user",
          "--unshare-ipc",
          "--bind",
          "/",
          "/",
          "--tmpfs",
          X11_DIR,
          "--",
          start.sleepPath,
          "infinity",
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
  while (Date.now() < deadline && proc.exitCode === null) {
    holder = proc.pid === undefined ? null : holderPid(proc.pid)
    if (holder !== null && mounted(holder) && (start.kind === "bwrap" || configured(holder))) {
      const started: TaskHolder = { proc, holder }
      proc.on("exit", () => {
        if (holders.get(opts.taskId) === started) holders.delete(opts.taskId)
      })
      return started
    }
    await Bun.sleep(POLL_MS)
  }
  // The holder does not exit with its starter, so both are killed.
  proc.kill("SIGKILL")
  if (holder !== null) kill({ proc, holder })
  throw new Error(stderr.trim() || `${start.kind} exit ${proc.exitCode ?? "timeout"}`)
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
        pending = startHolder(opts)
          .then((h) => {
            holders.set(opts.taskId, h)
            return h
          })
          .finally(() => starting.delete(opts.taskId))
        starting.set(opts.taskId, pending)
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
  const h = holders.get(taskId)
  if (!h) return
  holders.delete(taskId)
  kill(h)
}

export const stopAllTaskHolders = (): void => {
  for (const taskId of [...holders.keys()]) stopTaskHolder(taskId)
}

// Namespaces must not outlive the box, even when shutdown hooks never ran (systemd also stops the slice).
process.on("exit", stopAllTaskHolders)

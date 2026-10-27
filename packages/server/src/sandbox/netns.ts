import { Effect } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { InternalError } from "@cloudagents/protocol"
import { busEnv, scopeArgs, type SystemdSettings } from "./systemd"

/**
 * One network namespace per task, shared by every sandbox of that task (agent run, workspace_exec,
 * desktop apps), so a browser on the task desktop reaches the agent's dev server on localhost.
 *
 * `pasta` creates a user + network namespace around a `sleep infinity` holder and gives it outbound
 * internet through user-space NAT. Sandboxes join it with `nsenter --user --net`. Inside, loopback
 * is the task's own: host services on 127.0.0.1 and other X servers' abstract sockets are out of
 * reach. The one way back to the host is the box port, forwarded with `-T` (broker and MCP).
 * `--no-map-gw` keeps pasta from mapping its gateway address to the host's loopback.
 */
interface TaskNet {
  readonly pasta: ChildProcess
  /** Host pid of the holder; `nsenter --target` joins its namespaces. */
  readonly holder: number
}

const nets = new Map<string, TaskNet>()

const START_TIMEOUT_MS = 5_000
const POLL_MS = 25

const alive = (net: TaskNet): boolean => {
  if (net.pasta.exitCode !== null || net.pasta.signalCode !== null) return false
  try {
    process.kill(net.holder, 0)
    return true
  } catch {
    return false
  }
}

/** Host pid of pasta's command, once it has forked it. */
const holderPid = (pasta: number): number | null => {
  try {
    const first = readFileSync(`/proc/${pasta}/task/${pasta}/children`, "utf8").trim().split(" ")[0]
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

const kill = (net: TaskNet) => {
  for (const pid of [net.holder, net.pasta.pid]) {
    if (pid === undefined) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

export interface TaskNetOptions {
  readonly taskId: string
  /** Box HTTP port forwarded into the namespace (broker and MCP at 127.0.0.1:<port>). */
  readonly boxPort: number
  readonly pastaPath: string
  /** `sleep` from the sandbox toolchain. */
  readonly sleepPath: string
  /** With systemd, pasta and the holder live in the task slice, so task removal and box restarts kill them. */
  readonly systemd: { readonly settings: SystemdSettings; readonly systemdRun: string } | null
}

const startNet = async (opts: TaskNetOptions): Promise<TaskNet> => {
  // pasta forwards ports automatically in both directions unless told otherwise: nothing inbound
  // (`-t`/`-u none`, so task servers are not published on the host) and only the box port outbound.
  const pastaArgs = [
    "--config-net",
    "--no-map-gw",
    "-t",
    "none",
    "-u",
    "none",
    "-T",
    String(opts.boxPort),
    "-U",
    "none",
    "-q",
    "-f",
    "--",
    opts.sleepPath,
    "infinity",
  ]
  // systemd-run --scope execs in place, so the spawned pid is pasta's.
  const [file, args] = opts.systemd
    ? [opts.systemd.systemdRun, [...scopeArgs(opts.systemd.settings, opts.taskId, "net"), opts.pastaPath, ...pastaArgs]]
    : [opts.pastaPath, pastaArgs]
  const pasta = spawn(file, args, { env: { PATH: process.env.PATH ?? "", ...busEnv() }, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  pasta.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  let holder: number | null = null
  while (Date.now() < deadline && pasta.exitCode === null) {
    holder = pasta.pid === undefined ? null : holderPid(pasta.pid)
    if (holder !== null && configured(holder)) {
      const net: TaskNet = { pasta, holder }
      pasta.on("exit", () => {
        if (nets.get(opts.taskId) === net) nets.delete(opts.taskId)
      })
      return net
    }
    await Bun.sleep(POLL_MS)
  }
  // The holder does not exit with pasta, so both are killed.
  pasta.kill("SIGKILL")
  if (holder !== null) kill({ pasta, holder })
  throw new Error(stderr.trim() || `pasta exit ${pasta.exitCode ?? "timeout"}`)
}

/** In-flight starts, so concurrent launches of one task share a namespace. */
const starting = new Map<string, Promise<TaskNet>>()

/** Holder pid of the task's network namespace, starting pasta when there is none (or it died). */
export const ensureTaskNet = (opts: TaskNetOptions): Effect.Effect<number, InternalError> =>
  Effect.tryPromise({
    try: async () => {
      const existing = nets.get(opts.taskId)
      if (existing && alive(existing)) return existing.holder
      if (existing) stopTaskNet(opts.taskId)
      let pending = starting.get(opts.taskId)
      if (!pending) {
        pending = startNet(opts)
          .then((net) => {
            nets.set(opts.taskId, net)
            return net
          })
          .finally(() => starting.delete(opts.taskId))
        starting.set(opts.taskId, pending)
      }
      return (await pending).holder
    },
    catch: (e) => new InternalError({ message: `task network did not come up: ${e instanceof Error ? e.message : String(e)}` }),
  })

/** Argv prefix that runs the following command inside the task's namespace with the box user's own uid. */
export const joinTaskNet = (nsenterPath: string, holder: number): string[] => [
  nsenterPath,
  "--target",
  String(holder),
  "--user",
  "--net",
  "--preserve-credentials",
  "--",
]

export const stopTaskNet = (taskId: string): void => {
  const net = nets.get(taskId)
  if (!net) return
  nets.delete(taskId)
  kill(net)
}

export const stopAllTaskNets = (): void => {
  for (const taskId of [...nets.keys()]) stopTaskNet(taskId)
}

// Namespaces must not outlive the box, even when shutdown hooks never ran (systemd also stops the slice).
process.on("exit", stopAllTaskNets)

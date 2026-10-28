import { Effect } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { InternalError } from "@cloudagents/protocol"

/**
 * Resource limits for every sandboxed process, enforced by the user's systemd manager.
 *
 * Each task gets a slice `<box>-t<task>.slice` carrying the limits; every sandbox launch for that
 * task (agent run, workspace_exec, desktop apps) is a transient scope inside it, so the limits cap
 * the task as a whole. Slice names nest on `-`: everything sits under `kestrel.slice`.
 */
export interface TaskLimits {
  /** systemd MemoryMax, e.g. "4G". Swap is disabled for the slice so this is a hard cap. */
  readonly memoryMax: string
  /** systemd CPUQuota, e.g. "200%" (two cores). */
  readonly cpuQuota: string
  /** systemd TasksMax: processes + threads. */
  readonly tasksMax: string
}

export interface SystemdSettings {
  /** Slice name without `.slice`, unique per box (e.g. `kestrel-box8787`). */
  readonly boxSlice: string
  readonly limits: TaskLimits
}

/** `net` is the task's network namespace holder (pasta); the rest are sandboxed processes. */
export type LaunchKind = "run" | "exec" | "desktop" | "net"

/** Variables systemd-run/systemctl need to reach the user manager; never passed into bwrap. */
export const busEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}

/** `-` nests slices, so ids are reduced to alphanumerics. */
export const taskSlice = (settings: SystemdSettings, taskId: string): string =>
  `${settings.boxSlice}-t${taskId.replace(/[^A-Za-z0-9]/g, "")}.slice`

const systemctl = (args: ReadonlyArray<string>): Effect.Effect<void, InternalError> =>
  Effect.async<void, InternalError>((resume) => {
    execFile("systemctl", ["--user", ...args], { env: process.env, timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() || err.message
        resume(Effect.fail(new InternalError({ message: `systemctl --user ${args.join(" ")}: ${detail}` })))
      } else {
        resume(Effect.void)
      }
    })
  })

/** Writes the task slice's limits (runtime drop-in); idempotent, so it runs before every launch. */
export const applyTaskLimits = (settings: SystemdSettings, taskId: string): Effect.Effect<void, InternalError> =>
  systemctl([
    "set-property",
    "--runtime",
    taskSlice(settings, taskId),
    `MemoryMax=${settings.limits.memoryMax}`,
    "MemorySwapMax=0",
    `CPUQuota=${settings.limits.cpuQuota}`,
    `TasksMax=${settings.limits.tasksMax}`,
  ])

/** systemd-run args (without the executable) that run the following command in a fresh task scope. */
export const scopeArgs = (settings: SystemdSettings, taskId: string, kind: LaunchKind): string[] => [
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  `--unit=${settings.boxSlice}-${kind}-${randomUUID()}`,
  `--slice=${taskSlice(settings, taskId)}`,
  // The namespace holder is PID 1 of pasta's PID namespace, which ignores SIGTERM sent from outside it, so a stop
  // would wait out the 90 s stop timeout before SIGKILL. pasta and the holder keep no state, so they are killed outright.
  ...(kind === "net" ? ["--property=KillSignal=SIGKILL"] : []),
  "--",
]

/** Kills everything still running for the task and drops its slice limits. */
export const removeTask = (settings: SystemdSettings, taskId: string): Effect.Effect<void, InternalError> =>
  Effect.gen(function* () {
    const slice = taskSlice(settings, taskId)
    yield* systemctl(["stop", slice])
    yield* systemctl(["revert", slice])
  })

/**
 * Box startup: kills sandboxes a previous box instance left behind, then proves the user manager
 * accepts a limited scope so a misconfigured host fails here instead of on the first task.
 */
export const initBox = (settings: SystemdSettings): Effect.Effect<void, InternalError> =>
  Effect.gen(function* () {
    yield* systemctl(["stop", `${settings.boxSlice}.slice`])
    const probe = "probe"
    yield* applyTaskLimits(settings, probe)
    yield* Effect.async<void, InternalError>((resume) => {
      execFile(
        "systemd-run",
        [...scopeArgs(settings, probe, "exec"), "true"],
        { env: process.env, timeout: 15_000 },
        (err, _stdout, stderr) => {
          resume(
            err
              ? Effect.fail(
                  new InternalError({
                    message: `systemd-run --user --scope failed (${stderr.trim() || err.message}); the box needs a user systemd manager with the memory, cpu and pids controllers delegated (set CLOUDAGENTS_SYSTEMD=0 to run without limits)`,
                  }),
                )
              : Effect.void,
          )
        },
      )
    })
    yield* removeTask(settings, probe)
  })

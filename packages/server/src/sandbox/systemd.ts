import { Effect } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { InternalError } from "@cloudagents/protocol"

/**
 * Resource limits for every sandboxed process, enforced by the user's systemd manager.
 *
 * Each task gets a slice `<box>-t<task>.slice` carrying its limits; every sandbox launch for that task (agent run,
 * workspace_exec, desktop apps) is a transient scope inside it. Slice names nest on `-`: everything sits under the box's
 * slice `<box>.slice`, which carries the box totals. How tasks share the box is the provisioning mode:
 * - `guaranteed`: each task keeps `memoryMin` (MemoryLow) and a `cpuWeight` share; no task is capped below the box.
 * - `pooled`: tasks share the box totals with no per-task guarantee or cap.
 * - `per-thread`: each task is capped at `memoryMax` and `cpuQuota`, inside the box totals.
 * Every mode bounds the processes of a task with `TasksMax`.
 */
export type Provisioning = "guaranteed" | "pooled" | "per-thread"

export interface TaskLimits {
  /** systemd MemoryLow (guaranteed): memory a task keeps before the kernel reclaims it from others, e.g. "1G". */
  readonly memoryMin: string
  /** systemd CPUWeight (guaranteed): a task's CPU share relative to the others, 1-10000. */
  readonly cpuWeight: number
  /** systemd MemoryMax (per-thread), e.g. "4G". Swap is disabled for the slice so this is a hard cap. */
  readonly memoryMax: string
  /** systemd CPUQuota (per-thread), e.g. "200%" (two cores). */
  readonly cpuQuota: string
  /** systemd TasksMax: processes + threads per task. */
  readonly tasksMax: string
}

/** The whole box's memory and CPU, all tasks together. Swap is disabled for the box slice too. */
export interface BoxLimits {
  /** systemd MemoryMax, e.g. "80%". */
  readonly memoryMax: string
  /** systemd CPUQuota, e.g. "600%" (six cores). */
  readonly cpuQuota: string
}

export interface SystemdSettings {
  /** Slice name without `.slice`, unique per box (e.g. `kestrel-box8787`). */
  readonly boxSlice: string
  readonly provisioning: Provisioning
  readonly limits: TaskLimits
  readonly box: BoxLimits
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

/**
 * The task slice's cgroup, relative to the cgroup2 mount (e.g. `/user.slice/…/kestrel-box8787-t1.slice`); null while
 * the slice has never been active. Its memory and CPU accounting files are what the per-thread graphs read.
 */
export const sliceCgroup = (settings: SystemdSettings, taskId: string): Effect.Effect<string | null, InternalError> =>
  Effect.async<string | null, InternalError>((resume) => {
    const args = ["--user", "show", "--property=ControlGroup", "--value", taskSlice(settings, taskId)]
    execFile("systemctl", args, { env: process.env, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() || err.message
        resume(Effect.fail(new InternalError({ message: `systemctl ${args.join(" ")}: ${detail}` })))
        return
      }
      const path = stdout.trim()
      resume(Effect.succeed(path === "" ? null : path))
    })
  })

/**
 * The `Key=Value` properties a task's slice carries under the box's provisioning mode. Every mode sets every property:
 * runtime drop-ins outlive the box, so a slice made under another mode must not keep that mode's caps or floors.
 */
const taskProperties = (settings: SystemdSettings): string[] => {
  const { limits } = settings
  const guaranteed = settings.provisioning === "guaranteed"
  const perThread = settings.provisioning === "per-thread"
  return [
    `MemoryLow=${guaranteed ? limits.memoryMin : "0"}`,
    `CPUWeight=${guaranteed ? limits.cpuWeight : 100}`,
    `MemoryMax=${perThread ? limits.memoryMax : "infinity"}`,
    `MemorySwapMax=${perThread ? "0" : "infinity"}`,
    // An empty CPUQuota clears it.
    `CPUQuota=${perThread ? limits.cpuQuota : ""}`,
    `TasksMax=${limits.tasksMax}`,
  ]
}

/** The most memory and CPU one task can get: its own caps under per-thread provisioning, the box totals otherwise. */
export const taskCeilings = (settings: SystemdSettings): BoxLimits =>
  settings.provisioning === "per-thread"
    ? { memoryMax: settings.limits.memoryMax, cpuQuota: settings.limits.cpuQuota }
    : settings.box

/** Writes the task slice's limits (runtime drop-in); idempotent, so it runs before every launch. */
export const applyTaskLimits = (settings: SystemdSettings, taskId: string): Effect.Effect<void, InternalError> =>
  systemctl(["set-property", "--runtime", taskSlice(settings, taskId), ...taskProperties(settings)])

/** Writes the box slice's totals (runtime drop-in) at box startup. */
const applyBoxLimits = (settings: SystemdSettings): Effect.Effect<void, InternalError> =>
  systemctl([
    "set-property",
    "--runtime",
    `${settings.boxSlice}.slice`,
    `MemoryMax=${settings.box.memoryMax}`,
    "MemorySwapMax=0",
    `CPUQuota=${settings.box.cpuQuota}`,
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
    yield* applyBoxLimits(settings)
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

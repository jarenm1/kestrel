import { Effect } from "effect"
import { InternalError } from "@cloudagents/protocol"
import { killProcessGroup } from "../process"

/** Whether a run may use the GPU now: a standing `gpu_request` grant, or a GPU physically present on the host. */
export type GpuAvailability = (runId: string) => Effect.Effect<boolean>

/** The workload's process groups. The coordinator kills any that are still alive before the lease is freed. */
export interface GpuWorkload {
  /** Records the group leader of the workload (see `runProcess`'s `onSpawn`). */
  readonly trackGroup: (pid: number | undefined) => void
}

export interface GpuLease {
  readonly taskId: string
  readonly runId: string
}

export interface GpuCoordinatorOptions {
  readonly available: GpuAvailability
  /** Kills a process group. Defaults to the box's `killProcessGroup`. */
  readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void
  /** Whether a process group still has members. Defaults to `kill(-pid, 0)` succeeding. */
  readonly groupAlive?: (pid: number) => boolean
  /** How long cleanup waits for a killed group to disappear. Defaults to 5 s. */
  readonly cleanupTimeoutMs?: number
  /** How often cleanup checks a killed group. Defaults to 50 ms. */
  readonly cleanupPollMs?: number
}

export interface GpuCoordinatorShape {
  /**
   * Runs one foreground GPU workload under a lease. The GPU must be available to `runId` first, so an ordinary box
   * without a GPU fails closed instead of silently rendering on the CPU. On success, failure, timeout or interruption
   * every process group the workload started is killed before the lease is released.
   */
  readonly run: <A, E>(
    lease: GpuLease,
    work: (workload: GpuWorkload) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | InternalError>
  /** How many GPU workloads are active for a task (diagnostics and tests). */
  readonly active: (taskId: string) => number
}

/** The default check: a killed process group is gone once `kill(-pgid, 0)` reports ESRCH. */
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

interface ActiveLease extends GpuLease {
  readonly groups: Set<number>
}

const unavailableMessage =
  "GPU work was requested, but no GPU is available to this run. On a box with an on-demand GPU, call gpu_request " +
  "first and retry once it is attached; on a host with a GPU, check that a DRI render node (/dev/dri/renderD*) is " +
  "present and readable by the box user."

/**
 * Supervises foreground GPU commands so a command (and anything it started) cannot outlive its GPU lease. The
 * coordinator does not decide whether the desktop may use the GPU; it only gates and cleans up `workspace_exec` GPU
 * work. Because GPU work is run through `runProcess`, a timeout or Stop interrupts the same Effect and takes the same
 * cleanup path as normal completion.
 */
export const makeGpuCoordinator = (options: GpuCoordinatorOptions): GpuCoordinatorShape => {
  const killGroup = options.killGroup ?? killProcessGroup
  const alive = options.groupAlive ?? groupAlive
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000
  const cleanupPollMs = options.cleanupPollMs ?? 50
  const leases = new Set<ActiveLease>()

  const terminate = (lease: ActiveLease): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const pid of lease.groups) killGroup(pid, "SIGKILL")
      const deadline = Date.now() + cleanupTimeoutMs
      while ([...lease.groups].some(alive)) {
        if (Date.now() >= deadline) {
          // A finalizer cannot fail into the caller's result, so report it and free the lease anyway.
          yield* Effect.logWarning(
            `GPU workload for task ${lease.taskId} did not release its process group within ${cleanupTimeoutMs / 1000}s`,
          )
          return
        }
        yield* Effect.sleep(cleanupPollMs)
      }
    }).pipe(Effect.uninterruptible)

  return {
    run: (lease, work) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (!(yield* options.available(lease.runId))) {
            return yield* Effect.fail(new InternalError({ message: unavailableMessage }))
          }
          const active: ActiveLease = { ...lease, groups: new Set() }
          leases.add(active)
          return active
        }),
        (active) =>
          work({
            trackGroup: (pid) => {
              if (pid !== undefined) active.groups.add(pid)
            },
          }),
        (active) =>
          // The lease is freed even if a group refuses to die, so a failed cleanup does not wedge later GPU work.
          terminate(active).pipe(Effect.ensuring(Effect.sync(() => leases.delete(active)))),
      ),
    active: (taskId) => [...leases].filter((lease) => lease.taskId === taskId).length,
  }
}

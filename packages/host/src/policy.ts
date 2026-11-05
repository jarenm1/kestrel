/**
 * Pure resource and lifecycle policy. The host samples a running VM's guest status every few seconds and asks these
 * functions what to change. They hold no I/O and no clocks: callers pass `now` and the previous `ScaleState`.
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Memory never shrinks below this, whatever the guest uses. */
export const MIN_MEMORY_BYTES = GIB
/** Memory is plugged and unplugged in blocks of this size (virtio-mem). */
export const MEMORY_STEP_BYTES = 128 * MIB
const MIN_HEADROOM_BYTES = 512 * MIB
/** Shrinking waits until the target has been below the size for this long, and takes at most one step per interval. */
export const SHRINK_AFTER_MS = 60_000
export const SHRINK_INTERVAL_MS = 30_000
/** Guest memory pressure (`some avg10`) above this grows the VM at once. */
export const MEMORY_PRESSURE_AVG10 = 10
/** Guest CPU pressure (`some avg10`) above this adds a vCPU at once. */
export const CPU_PRESSURE_AVG10 = 20
/** Host memory pressure (`some avg10`) above this suspends the least recently active running VM. */
export const HOST_MEMORY_PRESSURE_AVG10 = 20
/** Suspending a VM writes its memory to the disk; below this much free space, idle VMs are parked instead. */
export const MIN_SNAPSHOT_FREE_BYTES = GIB
/** A VM whose cgroup used more than this fraction of one CPU since the last sample counts as active. */
export const CPU_ACTIVE_FRACTION = 0.05

export interface GuestSample {
  readonly memTotalBytes: number
  readonly memAvailableBytes: number
  readonly memSomeAvg10: number
  readonly cpuSomeAvg10: number
  readonly loadAvg1: number
}

/** Hysteresis state for one resource. `belowSince` is when the target first dropped under the current size. */
export interface ScaleState {
  readonly belowSince: number | null
  readonly lastStepAt: number
}

export const NO_SCALE: ScaleState = { belowSince: null, lastStepAt: 0 }

/** Guest memory in use, rounded up to a plug step, with at least 512 MiB or a quarter of use as headroom. */
export const memoryHeadroomBytes = (usedBytes: number): number => {
  const raw = Math.max(MIN_HEADROOM_BYTES, Math.ceil(usedBytes * 0.25))
  return Math.ceil(raw / MEMORY_STEP_BYTES) * MEMORY_STEP_BYTES
}

export const memoryTargetBytes = (sample: GuestSample, maxMemoryBytes: number): number => {
  const used = Math.max(0, sample.memTotalBytes - sample.memAvailableBytes)
  const wanted = Math.max(MIN_MEMORY_BYTES, used + memoryHeadroomBytes(used))
  const aligned = Math.ceil(wanted / MEMORY_STEP_BYTES) * MEMORY_STEP_BYTES
  return Math.min(maxMemoryBytes, aligned)
}

/** Memory with no headroom: what the guest uses, rounded up to a plug step. Host memory pressure shrinks to this. */
export const memoryFloorBytes = (sample: GuestSample, maxMemoryBytes: number): number => {
  const used = Math.max(0, sample.memTotalBytes - sample.memAvailableBytes)
  const aligned = Math.ceil(Math.max(MIN_MEMORY_BYTES, used) / MEMORY_STEP_BYTES) * MEMORY_STEP_BYTES
  return Math.min(maxMemoryBytes, aligned)
}

export const vcpuTarget = (sample: GuestSample, maxVcpus: number): number =>
  Math.min(maxVcpus, Math.max(1, Math.ceil(sample.loadAvg1 + 1)))

/**
 * Next size for one resource. Pressure grows it to `target` at once (the caller passes a target above `current`).
 * A target below `current` shrinks it by at most `shrinkStep` per interval, and only after a sustained surplus.
 */
export const stepSize = (input: {
  readonly now: number
  readonly current: number
  readonly target: number
  readonly pressured: boolean
  readonly shrinkStep: number
  readonly state: ScaleState
}): { readonly next: number; readonly state: ScaleState } => {
  const { now, current, target, pressured, shrinkStep, state } = input
  if (pressured && target > current) return { next: target, state: { belowSince: null, lastStepAt: now } }
  if (target >= current) return { next: current, state: { belowSince: null, lastStepAt: state.lastStepAt } }
  const belowSince = state.belowSince ?? now
  const due = now - belowSince >= SHRINK_AFTER_MS && now - state.lastStepAt >= SHRINK_INTERVAL_MS
  if (!due) return { next: current, state: { belowSince, lastStepAt: state.lastStepAt } }
  return { next: Math.max(target, current - shrinkStep), state: { belowSince, lastStepAt: now } }
}

/** Activity that keeps a VM from being idle, as the guest reports it. */
export interface ActivityCounts {
  readonly runs: number
  readonly desktops: number
  readonly viewers: number
  readonly recordings: number
}

/** True when a VM's cgroup used more than `CPU_ACTIVE_FRACTION` of one CPU over `elapsedMs`. */
export const cpuActive = (opts: { readonly usecDelta: number; readonly elapsedMs: number }): boolean =>
  opts.elapsedMs > 0 && opts.usecDelta > opts.elapsedMs * 1000 * CPU_ACTIVE_FRACTION

/**
 * Last time the VM was used, from what the host measures: its start, the last ingress request, and the last sample
 * in which its cgroup was busy. The guest's own report does not count, so a guest cannot keep itself awake.
 */
export const lastActiveAt = (opts: {
  readonly runningSince: number
  readonly lastRequestAt: number | null
  readonly lastCpuActiveAt: number | null
}): number => Math.max(opts.runningSince, opts.lastRequestAt ?? 0, opts.lastCpuActiveAt ?? 0)

/**
 * Idle means nothing running, no viewers or recordings, no open ingress connections, and no host-measured activity for
 * `idleAfterMs`. `activity` is the guest's last fresh report, or null when there is none: the guest then counts as doing
 * nothing and the host's own signals (ingress, CPU) decide, so a hung or silent guest cannot keep its box awake forever.
 */
export const isIdle = (opts: {
  readonly now: number
  readonly activity: ActivityCounts | null
  readonly lastActiveMs: number
  readonly openConnections: number
  readonly idleAfterMs: number
}): boolean => {
  const { activity } = opts
  const busy = activity === null ? 0 : activity.runs + activity.desktops + activity.viewers + activity.recordings
  return busy === 0 && opts.openConnections === 0 && opts.now - opts.lastActiveMs >= opts.idleAfterMs
}

/** The running VM to suspend under host memory pressure: the least recently active one. */
export const pickSuspendVictim = (candidates: readonly { readonly boxId: string; readonly lastActiveMs: number }[]): string | null => {
  let victim: { readonly boxId: string; readonly lastActiveMs: number } | null = null
  for (const candidate of candidates) {
    if (victim === null || candidate.lastActiveMs < victim.lastActiveMs) victim = candidate
  }
  return victim?.boxId ?? null
}

/** Free space left after reserving the memory of every running VM, which all may need to be snapshotted. */
export const diskFreeBytes = (opts: { readonly availableBytes: number; readonly runningMemoryBytes: number }): number =>
  Math.max(0, opts.availableBytes - opts.runningMemoryBytes)

export const diskTight = (freeBytes: number): boolean => freeBytes < MIN_SNAPSHOT_FREE_BYTES

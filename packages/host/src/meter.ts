import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { MeterMeasurements, MeterRecord, MeterState } from "@cloudagents/protocol"

/** The meter's view of one VM at a sample instant. */
export interface MeterVm {
  readonly boxId: string
  readonly vmId: string
  readonly userId: string
  readonly state: MeterState
  readonly gpus: number
  /** The VMM's cgroup, or null when the VMM does not run in a dedicated scope (then CPU and memory are unknown). */
  readonly cgroupDir: string | null
  /** The local volume image while it is held on this host, else null. */
  readonly volumePath: string | null
}

/** What one sample saw. A null field means the reading was unavailable, never zero. */
export interface Counters {
  readonly cpuUsec: number | null
  readonly memoryBytes: number | null
  readonly diskBytes: number | null
}

export interface OpenInterval extends Counters {
  readonly atMs: number
  readonly state: MeterState
  readonly gpus: number
}

const readFileSafe = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

const readCpuUsec = (cgroupDir: string): number | null => {
  const line = readFileSafe(join(cgroupDir, "cpu.stat"))?.split("\n").find((l) => l.startsWith("usage_usec "))
  if (line === undefined) return null
  const value = Number(line.slice("usage_usec ".length))
  return Number.isFinite(value) ? value : null
}

const readMemoryBytes = (cgroupDir: string): number | null => {
  const text = readFileSafe(join(cgroupDir, "memory.current"))
  if (text === null) return null
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

/** Bytes the volume image allocates on disk (a sparse file counts only what was written). */
const allocatedBytes = (path: string): number | null => {
  try {
    return statSync(path).blocks * 512
  } catch {
    return null
  }
}

const countersOf = (vm: MeterVm): Counters => {
  const cgroup = vm.state === "running" ? vm.cgroupDir : null
  return {
    cpuUsec: cgroup === null ? null : readCpuUsec(cgroup),
    memoryBytes: cgroup === null ? null : readMemoryBytes(cgroup),
    diskBytes: (vm.state === "running" || vm.state === "suspended") && vm.volumePath !== null ? allocatedBytes(vm.volumePath) : null,
  }
}

/**
 * Integrals over `[open.atMs, nowMs)`. A measurement is emitted only when both ends were observed; a missing one is
 * unknown and is left out, never reported as zero.
 */
export const usageMeasurements = (open: OpenInterval, end: Counters, nowMs: number): MeterMeasurements | null => {
  const seconds = (nowMs - open.atMs) / 1000
  const measurements: { cpuCoreSeconds?: number; memoryByteSeconds?: number; diskByteSeconds?: number; gpuDeviceSeconds?: number } = {}
  if (open.cpuUsec !== null && end.cpuUsec !== null) {
    measurements.cpuCoreSeconds = Math.max(0, end.cpuUsec - open.cpuUsec) / 1_000_000
  }
  if (open.memoryBytes !== null && end.memoryBytes !== null) {
    measurements.memoryByteSeconds = ((open.memoryBytes + end.memoryBytes) / 2) * seconds
  }
  if (open.diskBytes !== null && end.diskBytes !== null) {
    measurements.diskByteSeconds = ((open.diskBytes + end.diskBytes) / 2) * seconds
  }
  if (open.state === "running" && open.gpus > 0) {
    measurements.gpuDeviceSeconds = open.gpus * seconds
  }
  return Object.keys(measurements).length > 0 ? measurements : null
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * Samples each VM and turns the intervals between samples into immutable records. Ticks happen on a fixed cadence
 * and at every state transition: the caller ticks with the old state just before it changes and with the new state
 * right after, so no interval mixes two states. A VM the host stops tracking is `forget`-ed after its final tick.
 */
export class Meter {
  private readonly open = new Map<string, OpenInterval>()

  constructor(
    private readonly hostId: string,
    private readonly emit: (record: MeterRecord) => void,
  ) {}

  tick(vm: MeterVm, nowMs: number): void {
    const previous = this.open.get(vm.boxId)
    if (previous !== undefined && nowMs > previous.atMs) {
      const measurements = usageMeasurements(previous, countersOf(vm), nowMs)
      if (measurements !== null) {
        this.emit({
          schemaVersion: 1,
          eventId: `usage-${vm.vmId}-${previous.atMs}`,
          hostId: this.hostId,
          vmId: vm.vmId,
          userId: vm.userId,
          observedAt: iso(nowMs),
          kind: "usage",
          start: iso(previous.atMs),
          end: iso(nowMs),
          measurements,
        })
      }
    }
    const changed = previous === undefined || previous.state !== vm.state || previous.gpus !== vm.gpus
    if (changed) {
      this.emit({
        schemaVersion: 1,
        eventId: `life-${vm.vmId}-${nowMs}`,
        hostId: this.hostId,
        vmId: vm.vmId,
        userId: vm.userId,
        observedAt: iso(nowMs),
        kind: "lifecycle",
        state: vm.state,
        ...(vm.gpus > 0 ? { gpus: vm.gpus } : {}),
      })
    }
    this.open.set(vm.boxId, { ...countersOf(vm), atMs: nowMs, state: vm.state, gpus: vm.gpus })
  }

  forget(boxId: string): void {
    this.open.delete(boxId)
  }
}

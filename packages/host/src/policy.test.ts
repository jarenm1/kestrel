import { describe, expect, test } from "bun:test"
import {
  MEMORY_STEP_BYTES,
  MIN_MEMORY_BYTES,
  NO_SCALE,
  SHRINK_AFTER_MS,
  SHRINK_INTERVAL_MS,
  cpuActive,
  diskTight,
  isIdle,
  lastActiveAt,
  memoryFloorBytes,
  memoryTargetBytes,
  pickSuspendVictim,
  stepSize,
  vcpuTarget,
} from "./policy"

const GIB = 1024 * 1024 * 1024
const sample = (usedBytes: number, loadAvg1 = 0) => ({
  memTotalBytes: 8 * GIB,
  memAvailableBytes: 8 * GIB - usedBytes,
  memSomeAvg10: 0,
  cpuSomeAvg10: 0,
  loadAvg1,
})

describe("memory target", () => {
  test("never below the floor, never above the VM's limit, always whole plug steps", () => {
    expect(memoryTargetBytes(sample(0), 4 * GIB)).toBe(MIN_MEMORY_BYTES)
    expect(memoryTargetBytes(sample(6 * GIB), 4 * GIB)).toBe(4 * GIB)
    expect(memoryTargetBytes(sample(1.5 * GIB), 8 * GIB) % MEMORY_STEP_BYTES).toBe(0)
  })

  test("leaves headroom above what is in use", () => {
    expect(memoryTargetBytes(sample(3 * GIB), 8 * GIB)).toBeGreaterThan(3 * GIB)
  })
})

describe("memory floor under host pressure", () => {
  test("is what the guest uses, with no headroom, in whole plug steps", () => {
    expect(memoryFloorBytes(sample(3 * GIB), 8 * GIB)).toBe(3 * GIB)
    expect(memoryFloorBytes(sample(0), 8 * GIB)).toBe(MIN_MEMORY_BYTES)
    expect(memoryFloorBytes(sample(6 * GIB), 4 * GIB)).toBe(4 * GIB)
  })

  test("is below the normal target, which keeps headroom", () => {
    expect(memoryFloorBytes(sample(3 * GIB), 8 * GIB)).toBeLessThan(memoryTargetBytes(sample(3 * GIB), 8 * GIB))
  })
})

describe("vcpu target", () => {
  test("follows load with one spare, bounded to [1, maxVcpus]", () => {
    expect(vcpuTarget(sample(0, 0), 4)).toBe(1)
    expect(vcpuTarget(sample(0, 1.2), 4)).toBe(3)
    expect(vcpuTarget(sample(0, 9), 4)).toBe(4)
  })
})

describe("stepSize", () => {
  test("pressure grows straight to the target", () => {
    const next = stepSize({ now: 1_000, current: 1, target: 4, pressured: true, shrinkStep: 1, state: NO_SCALE })
    expect(next.next).toBe(4)
  })

  test("a shrink waits for a sustained surplus, then steps down at most once per interval", () => {
    let state = NO_SCALE
    let size = 4
    const step = (now: number) => {
      const result = stepSize({ now, current: size, target: 1, pressured: false, shrinkStep: 1, state })
      size = result.next
      state = result.state
    }
    step(0)
    expect(size).toBe(4)
    step(SHRINK_AFTER_MS)
    expect(size).toBe(3)
    step(SHRINK_AFTER_MS + 1)
    expect(size).toBe(3)
    step(SHRINK_AFTER_MS + SHRINK_INTERVAL_MS)
    expect(size).toBe(2)
  })
})

describe("host-measured activity", () => {
  test("a guest cannot keep a VM active: only the host's own measurements count", () => {
    expect(lastActiveAt({ runningSince: 5, lastRequestAt: null, lastCpuActiveAt: null })).toBe(5)
    expect(lastActiveAt({ runningSince: 5, lastRequestAt: 7, lastCpuActiveAt: 9 })).toBe(9)
  })

  test("a cgroup that used more than 5% of one CPU over the sample is active; less is not", () => {
    expect(cpuActive({ usecDelta: 60_000, elapsedMs: 1_000 })).toBe(true)
    expect(cpuActive({ usecDelta: 10_000, elapsedMs: 1_000 })).toBe(false)
    expect(cpuActive({ usecDelta: 60_000, elapsedMs: 0 })).toBe(false)
  })
})

describe("idle", () => {
  const base = { now: 10_000_000, lastActiveMs: 0, openConnections: 0, idleAfterMs: 1_000 }
  const quiet = { runs: 0, desktops: 0, viewers: 0, recordings: 0 }

  test("a VM with no activity counts, no connections and a quiet window is idle", () => {
    expect(isIdle({ ...base, activity: quiet })).toBe(true)
  })

  test("a guest with no fresh report is judged by the host's own signals alone", () => {
    expect(isIdle({ ...base, activity: null })).toBe(true)
    expect(isIdle({ ...base, activity: null, openConnections: 1 })).toBe(false)
    expect(isIdle({ ...base, activity: null, lastActiveMs: base.now - 500 })).toBe(false)
  })

  test("runs, desktops, viewers, recordings or open connections keep a VM awake", () => {
    expect(isIdle({ ...base, activity: { ...quiet, viewers: 1 } })).toBe(false)
    expect(isIdle({ ...base, openConnections: 2, activity: quiet })).toBe(false)
  })

  test("recent activity keeps a VM awake until the idle window passes", () => {
    expect(isIdle({ ...base, lastActiveMs: base.now - 500, activity: quiet })).toBe(false)
  })
})

describe("suspend victim", () => {
  test("the least recently active box goes first; none when nothing runs", () => {
    expect(
      pickSuspendVictim([
        { boxId: "a", lastActiveMs: 50 },
        { boxId: "b", lastActiveMs: 10 },
        { boxId: "c", lastActiveMs: 30 },
      ]),
    ).toBe("b")
    expect(pickSuspendVictim([])).toBeNull()
  })
})

describe("disk", () => {
  test("free space below the snapshot reserve is tight", () => {
    expect(diskTight(GIB - 1)).toBe(true)
    expect(diskTight(2 * GIB)).toBe(false)
  })
})

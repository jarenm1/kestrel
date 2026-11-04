import { describe, expect, test } from "bun:test"
import { usageMeasurements } from "./meter"

const open = {
  atMs: 1_000,
  state: "running" as const,
  gpus: 0,
  cpuUsec: 2_000_000,
  memoryBytes: 1_000,
  diskBytes: 4_096,
}

describe("usage measurements", () => {
  test("CPU is the usec delta in core-seconds; memory and disk are trapezoid byte-seconds", () => {
    const measured = usageMeasurements(open, { cpuUsec: 5_000_000, memoryBytes: 3_000, diskBytes: 4_096 }, 11_000)
    expect(measured).toEqual({
      cpuCoreSeconds: 3,
      memoryByteSeconds: 2_000 * 10,
      diskByteSeconds: 4_096 * 10,
    })
  })

  test("an unobserved end is left out, never reported as zero", () => {
    const measured = usageMeasurements(open, { cpuUsec: null, memoryBytes: 3_000, diskBytes: null }, 11_000)
    expect(measured).toEqual({ memoryByteSeconds: 2_000 * 10 })
  })

  test("GPU time accrues only while running", () => {
    const withGpu = { ...open, gpus: 2 }
    expect(usageMeasurements(withGpu, { cpuUsec: null, memoryBytes: null, diskBytes: null }, 4_000)).toEqual({
      gpuDeviceSeconds: 6,
    })
    const suspended = { ...withGpu, state: "suspended" as const }
    expect(usageMeasurements(suspended, { cpuUsec: null, memoryBytes: null, diskBytes: null }, 4_000)).toBeNull()
  })

  test("nothing observed, nothing to report", () => {
    expect(usageMeasurements({ ...open, cpuUsec: null, memoryBytes: null, diskBytes: null }, { cpuUsec: null, memoryBytes: null, diskBytes: null }, 2_000)).toBeNull()
  })
})

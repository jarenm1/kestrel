import { describe, expect, test } from "bun:test"
import { recoverPlan, type RecoveryFacts } from "./recovery"
import type { VmRecord } from "./schema"

const GIB = 1024 * 1024 * 1024

const record = (overrides: Partial<VmRecord>): VmRecord => ({
  schemaVersion: 1,
  boxId: "box-1",
  vmId: "vm-1",
  userId: "user-1",
  ownerEpoch: 1,
  state: "running",
  since: 0,
  imageId: "image-1",
  publicUrl: "https://box-1.example.test",
  limits: { maxVcpus: 2, maxMemoryBytes: 2 * GIB, gpu: "none", volumeBytes: GIB },
  vcpus: 1,
  memoryBytes: GIB,
  gpus: [],
  gpuAttachedAt: null,
  volumeRef: null,
  backedUpAt: null,
  localRef: null,
  localDirty: true,
  frozen: false,
  network: null,
  process: null,
  volumeProcess: null,
  snapshotGen: null,
  cloneId: null,
  operation: null,
  lastError: null,
  ...overrides,
})

const alive: RecoveryFacts = { vmmAlive: true, volumeAlive: true, snapshotExists: false }

describe("recovery of a running VM", () => {
  test("a running VM that was found frozen is stopped and parked, never adopted", () => {
    const plan = recoverPlan(record({ state: "running", frozen: true }), alive)
    expect(plan.state).toBe("parked")
    expect(plan.adoptVmm).toBe(false)
    expect(plan.killVmm).toBe(true)
  })

  test("a running VM that was not frozen is adopted when its VMM is alive", () => {
    const plan = recoverPlan(record({ state: "running", frozen: false }), alive)
    expect(plan.state).toBe("running")
    expect(plan.adoptVmm).toBe(true)
    expect(plan.killVmm).toBe(false)
  })
})

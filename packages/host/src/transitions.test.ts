import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { HostError } from "./errors"
import { canTransition, transitionVm, updateVm } from "./transitions"
import type { VmRecord, VmState } from "./schema"

const record = (state: VmState, sequence = 3): VmRecord => ({
  schemaVersion: 1,
  vmId: randomUUID(),
  userId: "alice",
  hostId: randomUUID(),
  shape: { cpus: 2, memoryMb: 2048 },
  state,
  sequence,
  osDisk: "/tmp/os.raw",
  dataDisk: "/tmp/data.raw",
  volume: { label: "kestrel-data", uuid: randomUUID() },
  process: null,
  createdAt: "2026-11-02T06:00:00.000Z",
  updatedAt: "2026-11-02T06:00:00.000Z",
  runningReported: false,
  lastError: null,
})

const NOW = "2026-11-02T06:05:00.000Z"

describe("state machine", () => {
  test("allows the documented transitions", () => {
    expect(canTransition("stopped", "starting")).toBe(true)
    expect(canTransition("starting", "running")).toBe(true)
    expect(canTransition("starting", "stopped")).toBe(true)
    expect(canTransition("starting", "stopping")).toBe(true)
    expect(canTransition("running", "stopping")).toBe(true)
    expect(canTransition("running", "stopped")).toBe(true)
    expect(canTransition("stopping", "stopped")).toBe(true)
    expect(canTransition("stopped", "destroying")).toBe(true)
    expect(canTransition("destroying", "deleted")).toBe(true)
  })

  test("refuses everything else, including leaving deleted and stopped -> running", () => {
    expect(canTransition("stopped", "running")).toBe(false)
    expect(canTransition("stopped", "stopping")).toBe(false)
    expect(canTransition("running", "starting")).toBe(false)
    expect(canTransition("stopping", "running")).toBe(false)
    expect(canTransition("deleted", "stopped")).toBe(false)
    expect(canTransition("deleted", "destroying")).toBe(false)
  })

  test("transitionVm changes state, bumps sequence and sets the given fields", () => {
    const next = transitionVm(record("stopped"), "starting", { process: null, lastError: null }, NOW)
    expect(next.state).toBe("starting")
    expect(next.sequence).toBe(4)
    expect(next.updatedAt).toBe(NOW)
  })

  test("transitionVm throws HostError on an illegal transition", () => {
    expect(() => transitionVm(record("stopped"), "running", { process: null, lastError: null }, NOW)).toThrow(HostError)
  })

  test("updateVm changes fields without changing state or sequence", () => {
    const next = updateVm(record("stopping"), { lastError: "timed out" }, NOW)
    expect(next.state).toBe("stopping")
    expect(next.sequence).toBe(3)
    expect(next.lastError).toBe("timed out")
    expect(next.updatedAt).toBe(NOW)
  })
})

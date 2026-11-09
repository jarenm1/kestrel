import { expect, test } from "bun:test"
import type { NestVmReport } from "@cloudagents/protocol"
import { NEST_STANDARD_LIMITS } from "./nest-control"
import { transitionNestBox, type NestBoxPhase } from "./nest-transition"

const phase = (overrides: Partial<NestBoxPhase> = {}): NestBoxPhase => ({
  state: "running",
  createFailed: false,
  hostId: "host-a",
  vmSince: 100,
  pendingId: null,
  ...overrides,
})

const report = (state: NestVmReport["state"], since = 100, overrides: Partial<NestVmReport> = {}): NestVmReport => ({
  boxId: "box-1",
  vmId: "vm-1",
  userId: "alice",
  ownerEpoch: 1,
  state,
  since,
  imageId: "image-1",
  vcpus: state === "running" ? 4 : 0,
  memoryBytes: state === "running" ? 8 * 1024 ** 3 : 0,
  gpus: [],
  diskBytes: 0,
  volumeRef: null,
  backedUpAt: null,
  limits: NEST_STANDARD_LIMITS,
  ...overrides,
})

const apply = (current: NestBoxPhase, next: NestVmReport) =>
  transitionNestBox(current, { _tag: "vmReported", report: next })

test("a newer report moves the phase and records its since", () => {
  const next = apply(phase(), report("suspended", 200))
  expect(next).toMatchObject({
    _tag: "transitioned",
    phase: { state: "suspended", vmSince: 200, hostId: "host-a" },
    changed: true,
  })
})

test("equal since still lands, so repeated periodic patches are not dropped", () => {
  expect(apply(phase(), report("parked", 100))).toMatchObject({
    _tag: "transitioned",
    phase: { state: "parked", vmSince: 100 },
  })
})

test("an older report is stale and does not move the phase", () => {
  const current = phase({ state: "running", vmSince: 200 })
  expect(apply(current, report("parked", 199))).toEqual({
    _tag: "illegal",
    reason: "report-stale",
    phase: current,
  })
})

test("a running VM clears createFailed", () => {
  const current = phase({ state: "provisioning", createFailed: true })
  expect(apply(current, report("running", 200))).toMatchObject({
    phase: { state: "running", createFailed: false },
  })
})

test("a parked report releases the host only when no command is in flight", () => {
  expect(apply(phase(), report("parked", 200))).toMatchObject({ phase: { hostId: null } })
  expect(apply(phase({ pendingId: "cmd-1" }), report("parked", 200))).toMatchObject({
    phase: { hostId: "host-a", pendingId: "cmd-1" },
  })
})

test("an unreachable state edge is illegal but carries the log-and-continue phase", () => {
  expect(apply(phase({ state: "provisioning" }), report("parked", 200))).toEqual({
    _tag: "illegal",
    reason: "state-regression",
    phase: expect.objectContaining({ state: "parked", vmSince: 200 }),
  })
  expect(apply(phase(), report("provisioning", 200))).toMatchObject({
    _tag: "illegal",
    reason: "state-regression",
    phase: { state: "provisioning" },
  })
})

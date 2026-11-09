import { expect, test } from "bun:test"
import type { NestVmReport } from "@cloudagents/protocol"
import { NEST_STANDARD_LIMITS } from "./nest-control"
import { transitionNestBox, type NestBoxPhase } from "./nest-transition"

const phase = (overrides: Partial<NestBoxPhase> = {}): NestBoxPhase => ({
  state: "running",
  createFailed: false,
  hostId: "host-a",
  ownerEpoch: 1,
  vmId: "vm-1",
  vmSince: 100,
  wakeWanted: false,
  pendingId: null,
  pendingKind: null,
  pendingCommand: null,
  pendingDeadline: null,
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

const result = (
  current: NestBoxPhase,
  overrides: Partial<Extract<Parameters<typeof transitionNestBox>[1], { _tag: "commandResult" }>> = {},
) =>
  transitionNestBox(current, {
    _tag: "commandResult",
    ok: false,
    owed: false,
    vmPresent: false,
    ...overrides,
  })

const pending = (overrides: Partial<NestBoxPhase> = {}): NestBoxPhase =>
  phase({
    pendingId: "cmd",
    pendingKind: "create",
    pendingCommand: { _tag: "create", boxId: "box-1", userId: "alice", vmId: "vm-1", ownerEpoch: 1, limits: NEST_STANDARD_LIMITS, publicUrl: "https://box-1.example.com", enrollToken: "token" },
    pendingDeadline: 1000,
    ...overrides,
  })

test("a command result requires a pending command", () => {
  expect(result(phase())).toEqual({ _tag: "illegal", reason: "not-pending", phase: phase() })
})

test("a failed create marks a provisioning box and releases a claim with no VM", () => {
  expect(result(pending({ state: "provisioning" }))).toMatchObject({
    _tag: "transitioned",
    phase: { createFailed: true, hostId: null, pendingId: null, pendingKind: null },
  })
  expect(result(pending({ state: "provisioning" }), { vmPresent: true })).toMatchObject({
    _tag: "transitioned",
    phase: { createFailed: true, hostId: "host-a" },
  })
  expect(result(pending())).toEqual({
    _tag: "illegal",
    reason: "create-failed-on-live-vm",
    phase: { ...pending(), pendingId: null, pendingKind: null, pendingCommand: null, pendingDeadline: null },
  })
})

test("a lapse-owed create and non-create results leave createFailed alone", () => {
  const current = pending({ state: "provisioning", createFailed: true })
  expect(result(current, { owed: true })).toMatchObject({ phase: { createFailed: true, hostId: "host-a" } })
  expect(result(pending({ pendingKind: "resume" }), { owed: false })).toMatchObject({
    phase: { createFailed: false },
  })
})

test("a parked result without a VM report releases the claim; one with a report keeps it", () => {
  const parked = pending({ state: "parked", pendingKind: "resume" })
  expect(result(parked)).toMatchObject({ phase: { hostId: null } })
  expect(result(parked, { vmPresent: true })).toMatchObject({ phase: { hostId: "host-a" } })
})

test("dispatch records the command and clears the wake flag", () => {
  const command = pending().pendingCommand
  if (command === null) throw new Error("expected a stored pending command")
  expect(
    transitionNestBox(phase({ wakeWanted: true }), {
      _tag: "commandDispatched",
      commandId: "cmd",
      command,
      deadline: 2000,
    }),
  ).toMatchObject({
    _tag: "transitioned",
    phase: { pendingId: "cmd", pendingKind: "create", pendingDeadline: 2000, wakeWanted: false },
  })
  expect(
    transitionNestBox(pending(), { _tag: "commandDispatched", commandId: "cmd-2", command, deadline: null }),
  ).toEqual({ _tag: "illegal", reason: "already-pending", phase: pending() })
})

test("a create deadline marks failed but keeps the claim; a resume deadline asks for a wake", () => {
  expect(transitionNestBox(pending(), { _tag: "deadlineElapsed" })).toMatchObject({
    phase: { pendingId: null, createFailed: true, hostId: "host-a" },
  })
  expect(transitionNestBox(pending({ state: "suspended", pendingKind: "resume" }), { _tag: "deadlineElapsed" })).toMatchObject({
    phase: { pendingId: null, wakeWanted: true },
  })
})

test("wake events set the flag and a placement resets the VM baseline", () => {
  expect(transitionNestBox(phase(), { _tag: "wakeRequested" })).toMatchObject({ phase: { wakeWanted: true } })
  expect(transitionNestBox(phase(), { _tag: "wakeHeld" })).toMatchObject({ phase: { wakeWanted: true } })
  expect(
    transitionNestBox(phase({ state: "parked" }), {
      _tag: "placementChosen",
      hostId: "host-b",
      ownerEpoch: 2,
      vmId: "vm-2",
    }),
  ).toMatchObject({
    phase: { hostId: "host-b", ownerEpoch: 2, vmId: "vm-2", vmSince: null },
  })
})

test("a claim can move only when the box has no host", () => {
  expect(transitionNestBox(phase({ hostId: null }), { _tag: "claimMoved", hostId: "host-b" })).toMatchObject({
    phase: { hostId: "host-b" },
  })
  expect(transitionNestBox(phase(), { _tag: "claimMoved", hostId: "host-b" })).toEqual({
    _tag: "illegal",
    reason: "already-pending",
    phase: phase(),
  })
})

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

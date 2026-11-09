import { afterEach, describe, expect, test } from "bun:test"
import { NEST_LAPSE_REFUSAL, type NestHostCommand, type NestVmReport } from "@cloudagents/protocol"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { VmRecord } from "./schema"
import { stateLayout, vmPaths } from "./state-store"
import { destroyCommand, newTestManager, resumeCommand, testLimits, type TestManager } from "./vm-manager.fixture"
import type { VmManager } from "./vm-manager"
import type { VolumeTool } from "./volume"

let fixtures: TestManager[] = []
const fixture = (): TestManager => {
  const made = newTestManager()
  fixtures.push(made)
  return made
}
afterEach(() => {
  for (const made of fixtures.splice(0)) made.dispose()
})

describe("commands received before the lease lapsed or the connection dropped", () => {
  test("a resume queued before a lease lapse is refused with a failure, and the lapse-only refusal is not recorded", async () => {
    const { manager, applied, open, started } = fixture()
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroyCommand(1))
    await started
    const stale = manager.execute("cmd-stale", resumeCommand(1))
    manager.setLease(Date.now() - 1)
    manager.setLease(Date.now() + 60_000)
    open()
    await busy
    expect((await stale)?.outcome).toMatchObject({ commandId: "cmd-stale", ok: false })
    expect(applied).toEqual(["destroy"])
    expect(manager.pendingResults().map((outcome) => outcome.commandId)).toEqual(["cmd-busy"])
  })

  test("a resume queued before a disconnect is refused without a result, and is not recorded", async () => {
    const { manager, applied, open, started } = fixture()
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroyCommand(1))
    await started
    const stale = manager.execute("cmd-stale", resumeCommand(1))
    manager.connectionLost()
    manager.setLease(Date.now() + 60_000)
    open()
    await busy
    expect(await stale).toBeNull()
    expect(applied).toEqual(["destroy"])
    expect(manager.pendingResults().map((outcome) => outcome.commandId)).toEqual(["cmd-busy"])
  })

  test("a resend of the same commandId after reconnect runs once and is recorded", async () => {
    const { manager, applied, open, started } = fixture()
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroyCommand(1))
    await started
    const stale = manager.execute("cmd-resume", resumeCommand(1))
    manager.connectionLost()
    manager.setLease(Date.now() + 60_000)
    const resent = manager.execute("cmd-resume", resumeCommand(1))
    open()
    await busy
    expect(await stale).toBeNull()
    expect((await resent)?.outcome).toMatchObject({ commandId: "cmd-resume", ok: true })
    expect(applied).toEqual(["destroy", "resume"])
    expect(manager.pendingResults().filter((outcome) => outcome.commandId === "cmd-resume")).toHaveLength(1)
  })

  test("a command received during a lapse the tick fenced is refused even when renewal arrives before it runs", async () => {
    const { manager, applied, open } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    ;(manager as unknown as { tick: () => void }).tick()
    const received = manager.execute("cmd-resend", resumeCommand(1))
    manager.setLease(Date.now() + 60_000)
    open()
    expect((await received)?.outcome).toMatchObject({ commandId: "cmd-resend", ok: false })
    expect(manager.pendingResults()).toEqual([])
    expect(applied).toEqual([])
  })

  test("a command received during a lapse the tick did not see is refused the same way, even when renewal arrives before it runs", async () => {
    const { manager, applied, open } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    const received = manager.execute("cmd-resend", resumeCommand(1))
    manager.setLease(Date.now() + 60_000)
    open()
    expect((await received)?.outcome).toMatchObject({ commandId: "cmd-resend", ok: false })
    expect(manager.pendingResults()).toEqual([])
    expect(applied).toEqual([])
  })

  test("a command received after renewal runs, and a resend of the refused command then runs too", async () => {
    const { manager, applied } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    expect((await manager.execute("cmd-resend", resumeCommand(1)))?.outcome).toMatchObject({ ok: false })
    manager.setLease(Date.now() + 60_000)
    expect((await manager.execute("cmd-resend", resumeCommand(1)))?.outcome).toMatchObject({ ok: true })
    expect(applied).toEqual(["resume"])
  })

  test("a command received during a lapse the tick already fenced is refused with a failure, not recorded, and runs after renewal", async () => {
    const { manager, applied } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    ;(manager as unknown as { tick: () => void }).tick()
    const during = await manager.execute("cmd-resume", resumeCommand(1))
    expect(during?.outcome).toMatchObject({ commandId: "cmd-resume", ok: false })
    expect(manager.pendingResults()).toEqual([])
    expect(applied).toEqual([])
    manager.setLease(Date.now() + 60_000)
    const after = await manager.execute("cmd-resume", resumeCommand(1))
    expect(after?.outcome).toMatchObject({ commandId: "cmd-resume", ok: true })
    expect(applied).toEqual(["resume"])
  })

  test("a command that reaches execution during a lapse nothing has observed yet is refused, not recorded", async () => {
    const { manager, applied } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    const during = await manager.execute("cmd-resume", resumeCommand(1))
    expect(during?.outcome).toMatchObject({ commandId: "cmd-resume", ok: false })
    expect(manager.pendingResults()).toEqual([])
    expect(applied).toEqual([])
  })

  test("a renewal that fails to persist leaves the lapse as it was, and the next renewal lets a resend run", async () => {
    const { manager, applied, leasePath } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    rmSync(leasePath)
    mkdirSync(leasePath)
    expect(() => manager.setLease(Date.now() + 60_000)).toThrow()
    const during = await manager.execute("cmd-resume", resumeCommand(1))
    expect(during?.outcome).toMatchObject({ commandId: "cmd-resume", ok: false })
    rmSync(leasePath, { recursive: true })
    manager.setLease(Date.now() + 60_000)
    const after = await manager.execute("cmd-resume", resumeCommand(1))
    expect(after?.outcome).toMatchObject({ commandId: "cmd-resume", ok: true })
    expect(applied).toEqual(["resume"])
  })

  test.each([
    ["park", { _tag: "park" as const, boxId: "box-1", ownerEpoch: 1 }],
    ["destroy", { _tag: "destroy" as const, boxId: "box-1", ownerEpoch: 1 }],
  ])("a %s that reaches execution during a lapse is refused with a failure, not run and not recorded", async (_action, command) => {
    const { manager, applied } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    const refused = await manager.execute(`cmd-${command._tag}`, command)
    expect(refused?.outcome).toMatchObject({ commandId: `cmd-${command._tag}`, ok: false, error: NEST_LAPSE_REFUSAL })
    expect(applied).toEqual([])
    expect(manager.pendingResults()).toEqual([])
  })

  test("an operator command runs after a connection drop and a lapse: it is a request made on the host, not from control", async () => {
    const { manager, applied, open } = fixture()
    open()
    manager.setLease(Date.now() + 60_000)
    manager.connectionLost()
    manager.setLease(Date.now() - 1)
    const operator = await manager.executeOperator("cmd-operator", destroyCommand(1))
    expect(operator.outcome).toMatchObject({ commandId: "cmd-operator", ok: true })
    expect(applied).toEqual(["destroy"])
  })

  test("an outcome the store cannot write is answered from memory on a resend, so the command runs once", async () => {
    const { manager, applied, open, stateDir } = fixture()
    open()
    manager.setLease(Date.now() + 60_000)
    chmodSync(stateDir, 0o500)
    let first: Awaited<ReturnType<typeof manager.execute>>
    let resent: Awaited<ReturnType<typeof manager.execute>>
    try {
      first = await manager.execute("cmd-unstored", destroyCommand(1))
      resent = await manager.execute("cmd-unstored", destroyCommand(1))
    } finally {
      chmodSync(stateDir, 0o700)
    }
    expect(first?.outcome).toMatchObject({ commandId: "cmd-unstored", ok: true })
    expect(resent?.outcome).toEqual(first?.outcome)
    expect(applied).toEqual(["destroy"])
    expect(manager.pendingResults().map((outcome) => outcome.commandId)).toEqual(["cmd-unstored"])
    manager.markReported(["cmd-unstored"])
    expect(manager.pendingResults()).toEqual([])
    expect((await manager.execute("cmd-unstored", destroyCommand(1)))?.outcome).toMatchObject({ ok: true })
    expect(applied).toEqual(["destroy"])
  })

  test("a command already answered returns its stored outcome across a reconnect, without running again", async () => {
    const { manager, applied, open } = fixture()
    open()
    manager.setLease(Date.now() + 60_000)
    const first = await manager.execute("cmd-done", destroyCommand(1))
    manager.connectionLost()
    manager.setLease(Date.now() + 60_000)
    const again = await manager.execute("cmd-done", destroyCommand(1))
    expect(again?.outcome).toEqual(first?.outcome)
    expect(applied).toEqual(["destroy"])
  })
})

const GIB = 1024 * 1024 * 1024

const recordOf = (overrides: Partial<VmRecord>): VmRecord => ({
  schemaVersion: 1,
  boxId: "box-1",
  vmId: "vm-1",
  userId: "user-1",
  ownerEpoch: 1,
  state: "running",
  since: 0,
  imageId: "image-1",
  publicUrl: "https://box-1.example.test",
  limits: testLimits,
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
  tombstone: null,
  operation: null,
  lastError: null,
  ...overrides,
})

/** `VolumeTool` with mutable fields, so a test can point the manager at a fake executable. */
type TestVolumeTool = { -readonly [K in keyof VolumeTool]: VolumeTool[K] }

/** The manager's private record map and transition functions, as the tests exercise them directly. */
const internals = (manager: VmManager) =>
  manager as unknown as {
    records: Map<string, VmRecord>
    volume: TestVolumeTool
    recover: (record: VmRecord) => Promise<void>
    resumeCommand: (command: NestHostCommand) => Promise<void>
    destroy: (command: NestHostCommand) => Promise<void>
    evict: (command: NestHostCommand) => Promise<void>
    releaseVm: (vm: VmRecord) => Promise<VmRecord>
    finish: (vm: VmRecord, state: VmRecord["state"], patch: Partial<VmRecord>) => VmRecord
    report: (vm: VmRecord) => NestVmReport
  }

describe("recovery and volume safety", () => {
  test("recovery writes a stale freeze away, so the next restart does not stop a healthy box", async () => {
    const { manager, stateDir } = fixture()
    const internalsOf = internals(manager)
    const frozen = recordOf({ state: "running", frozen: true })
    internalsOf.records.set(frozen.boxId, frozen)

    await internalsOf.recover(frozen)

    const recovered = internalsOf.records.get(frozen.boxId)
    expect(recovered).toMatchObject({ state: "parked", frozen: false })
    const persisted = JSON.parse(readFileSync(vmPaths(stateLayout(stateDir), frozen.boxId).record, "utf8")) as VmRecord
    expect(persisted).toMatchObject({ state: "parked", frozen: false })
  })

  test("a higher-epoch resume with no backup refuses and keeps the local volume", async () => {
    const { manager, stateDir } = fixture()
    manager.setLease(Date.now() + 60_000)
    const internalsOf = internals(manager)
    const parked = recordOf({ state: "parked", ownerEpoch: 1, localDirty: true, volumeRef: null })
    internalsOf.records.set(parked.boxId, parked)
    const volume = vmPaths(stateLayout(stateDir), parked.boxId).volume
    mkdirSync(vmPaths(stateLayout(stateDir), parked.boxId).dir, { recursive: true })
    writeFileSync(volume, "unbacked local data")

    await expect(internalsOf.resumeCommand(resumeCommand(2))).rejects.toThrow(/no volume backup/)

    expect(existsSync(volume)).toBe(true)
    expect(internalsOf.records.get(parked.boxId)).toMatchObject({ ownerEpoch: 1, localDirty: true })
  })

  test("a destroy at either epoch keeps an evicted tombstone's backup", async () => {
    const { manager } = fixture()
    const internalsOf = internals(manager)
    const tombstone = recordOf({
      state: "deleted",
      ownerEpoch: 1,
      volumeRef: "vol-1",
      localDirty: false,
      tombstone: "evict",
    })
    internalsOf.records.set(tombstone.boxId, tombstone)

    // A duplicate destroy from the old epoch matches the tombstone's own epoch, and the new owner's epoch must not
    // wipe it either. The fixture's `kestrel-volume` is not installed, so any delete call would reject this test.
    await internalsOf.destroy(destroyCommand(1))
    await internalsOf.destroy(destroyCommand(2))

    expect(internalsOf.records.get(tombstone.boxId)).toMatchObject({
      state: "deleted",
      ownerEpoch: 1,
      volumeRef: "vol-1",
      tombstone: "evict",
    })
  })

  test("an evict interrupted before release recovers as an evict tombstone and keeps its backup", async () => {
    const { manager } = fixture()
    const internalsOf = internals(manager)
    const running = recordOf({ state: "running", ownerEpoch: 1, volumeRef: "vol-1", localDirty: false })
    internalsOf.records.set(running.boxId, running)
    // The host dies after the evict intent is committed and before the VM is released.
    internalsOf.releaseVm = async () => {
      throw new Error("simulated crash")
    }

    await expect(internalsOf.evict({ _tag: "evict", boxId: running.boxId, ownerEpoch: 2 })).rejects.toThrow(
      /simulated crash/,
    )

    const interrupted = internalsOf.records.get(running.boxId)
    expect(interrupted).toMatchObject({ tombstone: "evict", operation: { kind: "destroy" }, volumeRef: "vol-1" })
    if (interrupted === undefined) throw new Error("the evict intent was not committed")

    await internalsOf.recover(interrupted)

    expect(internalsOf.records.get(running.boxId)).toMatchObject({
      state: "deleted",
      tombstone: "evict",
      volumeRef: "vol-1",
      operation: null,
    })
    // A late duplicate destroy at the evicted epoch and one at the new owner's epoch both keep the backup.
    await internalsOf.destroy(destroyCommand(1))
    await internalsOf.destroy(destroyCommand(2))
    expect(internalsOf.records.get(running.boxId)).toMatchObject({ volumeRef: "vol-1" })
  })

  test("a missing backup keeps the local volume when the lazy restore cannot open it", async () => {
    const { manager, stateDir } = fixture()
    manager.setLease(Date.now() + 60_000)
    const internalsOf = internals(manager)
    const parked = recordOf({ state: "parked", ownerEpoch: 1, localDirty: false, volumeRef: "vol-missing" })
    internalsOf.records.set(parked.boxId, parked)
    const p = vmPaths(stateLayout(stateDir), parked.boxId)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.volume, "the only copy")
    // A tool that opens nothing and exits before printing a device: the manifest it was asked for could not be read.
    const tool = join(dirname(stateDir), "volume-tool-that-cannot-restore")
    writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    internalsOf.volume.tool = tool

    await expect(internalsOf.resumeCommand(resumeCommand(2, "vol-missing"))).rejects.toThrow()

    expect(readFileSync(p.volume, "utf8")).toBe("the only copy")
    expect(existsSync(`${p.volume}.previous`)).toBe(false)
    expect(internalsOf.records.get(parked.boxId)).toMatchObject({ state: "parked", ownerEpoch: 2 })
  })

  test("a crash after moving the local volume aside is rolled back on recovery", async () => {
    const { manager, stateDir } = fixture()
    manager.setLease(Date.now() + 60_000)
    const internalsOf = internals(manager)
    const parked = recordOf({
      state: "parked",
      ownerEpoch: 1,
      localDirty: false,
      volumeRef: "vol-missing",
      operation: { kind: "resume", from: "parked", startedAt: 1 },
    })
    internalsOf.records.set(parked.boxId, parked)
    const p = vmPaths(stateLayout(stateDir), parked.boxId)
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.volume, "the only copy")
    // The crash window: the local copy was moved aside, and the lazy restore had not opened its source yet.
    renameSync(p.volume, `${p.volume}.previous`)

    await internalsOf.recover(parked)

    expect(readFileSync(p.volume, "utf8")).toBe("the only copy")
    expect(existsSync(`${p.volume}.previous`)).toBe(false)

    // The retry hits the same unreadable manifest, and must still leave the restored local copy in place.
    const tool = join(dirname(stateDir), "volume-tool-that-cannot-restore")
    writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    internalsOf.volume.tool = tool
    await expect(internalsOf.resumeCommand(resumeCommand(2, "vol-missing"))).rejects.toThrow()

    expect(readFileSync(p.volume, "utf8")).toBe("the only copy")
    expect(existsSync(`${p.volume}.previous`)).toBe(false)
  })
})

describe("a state entered after the wall clock stepped back", () => {
  // The VM entered its current state an hour "ahead" of the clock: the host clock has since been stepped back.
  const aheadOfClock = (): number => Date.now() + 3_600_000

  /**
   * Control drops a report whose `since` is older than the last one it applied, so the new state must report later than
   * the one it left. The record's own `since` stays on the wall clock, so the host's park, idle and backup timers do not
   * wait out the step.
   */
  const expectOrderedAfter = (manager: VmManager, entered: VmRecord, left: VmRecord): void => {
    const internalsOf = internals(manager)
    expect(internalsOf.report(entered).since).toBeGreaterThan(internalsOf.report(left).since)
    expect(entered.since).toBeLessThanOrEqual(Date.now())
  }

  test("a finished operation reports after the state it left, with a wall-clock since", () => {
    const { manager } = fixture()
    const internalsOf = internals(manager)
    const running = recordOf({ state: "running", since: aheadOfClock() })
    internalsOf.records.set(running.boxId, running)

    const suspended = internalsOf.finish(running, "suspended", {})

    expect(suspended.state).toBe("suspended")
    expectOrderedAfter(manager, suspended, running)
    // A second transition orders after the first, not after the wall clock it fell behind.
    const resumed = internalsOf.finish(suspended, "running", {})
    expectOrderedAfter(manager, resumed, suspended)
  })

  test("recovery parks the VM with a since that reports after the state it left", async () => {
    const { manager } = fixture()
    const internalsOf = internals(manager)
    const running = recordOf({ state: "running", since: aheadOfClock() })
    internalsOf.records.set(running.boxId, running)

    await internalsOf.recover(running)

    const recovered = internalsOf.records.get(running.boxId)!
    expect(recovered.state).toBe("parked")
    expectOrderedAfter(manager, recovered, running)
  })

  test("a higher-epoch resume parks the VM with a since that reports after the state it left", async () => {
    const { manager, stateDir } = fixture()
    manager.setLease(Date.now() + 60_000)
    const internalsOf = internals(manager)
    const suspended = recordOf({ state: "suspended", since: aheadOfClock(), ownerEpoch: 1, volumeRef: "vol-1" })
    internalsOf.records.set(suspended.boxId, suspended)
    // The restore cannot open its backup, so the resume stops right after committing the new epoch's parked record.
    const tool = join(dirname(stateDir), "volume-tool-that-cannot-restore")
    writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    internalsOf.volume.tool = tool

    await expect(internalsOf.resumeCommand(resumeCommand(2, "vol-2"))).rejects.toThrow()

    const parked = internalsOf.records.get(suspended.boxId)!
    expect(parked).toMatchObject({ state: "parked", ownerEpoch: 2 })
    expectOrderedAfter(manager, parked, suspended)
  })
})

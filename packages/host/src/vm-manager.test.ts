import { afterEach, describe, expect, test } from "bun:test"
import { NEST_LAPSE_REFUSAL } from "@cloudagents/protocol"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { destroyCommand, newTestManager, resumeCommand, type TestManager } from "./vm-manager.fixture"

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

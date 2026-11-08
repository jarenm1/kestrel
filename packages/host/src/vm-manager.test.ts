import { afterEach, describe, expect, test } from "bun:test"
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

  test("a lapse the policy tick already fenced does not refuse a resend that arrives with the renewal", async () => {
    const { manager, applied, open } = fixture()
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    ;(manager as unknown as { tick: () => void }).tick()
    const resent = manager.execute("cmd-resend", resumeCommand(1))
    manager.setLease(Date.now() + 60_000)
    open()
    expect((await resent)?.outcome).toMatchObject({ commandId: "cmd-resend", ok: true })
    expect(applied).toEqual(["resume"])
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

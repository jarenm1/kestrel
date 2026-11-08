import { afterAll, describe, expect, test } from "bun:test"
import type { NestHostCommand } from "@cloudagents/protocol"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostConfig } from "./config"
import { ensureStateDirs, stateLayout } from "./state-store"
import { VmManager, type VmEvents } from "./vm-manager"

const GIB = 1024 * 1024 * 1024
const dir = mkdtempSync(join(tmpdir(), "vm-manager-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const guestDir = join(dir, "guest")
mkdirSync(guestDir)
writeFileSync(join(guestDir, "manifest.json"), JSON.stringify({ imageId: "image-1", kernel: "vmlinux", initrd: null, store: "store", cmdline: "cmdline" }))
writeFileSync(join(guestDir, "cmdline"), "console=ttyS0\n")

const events: VmEvents = { vm: () => {}, wakeRequest: () => {}, error: () => {}, notice: () => {} }
const limits = { maxVcpus: 2, maxMemoryBytes: 2 * GIB, gpu: "none" as const, volumeBytes: GIB }

/**
 * A manager whose `apply` is replaced by a recorder. `destroy` runs and blocks until `open()`, so commands sent after it
 * queue behind it the way they would behind a long park or backup on a real host. `started` resolves once it is running.
 */
const newManager = (name: string) => {
  const root = join(dir, name)
  mkdirSync(root)
  const layout = stateLayout(root)
  ensureStateDirs(layout)
  const config = {
    hostId: "host-1",
    stateDir: root,
    guestImageDir: guestDir,
    volumeTool: "kestrel-volume",
    volumeStore: "file:///unused",
    volumeKeyFile: null,
  } as unknown as HostConfig
  const manager = new VmManager(config, layout, events)
  const applied: string[] = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  ;(manager as unknown as { apply: (command: NestHostCommand) => Promise<void> }).apply = async (command) => {
    applied.push(command._tag)
    if (command._tag !== "destroy") return
    markStarted()
    await gate
  }
  return { manager, applied, open, started }
}

const destroy = (ownerEpoch: number): NestHostCommand => ({ _tag: "destroy", boxId: "box-1", ownerEpoch })
const resume = (ownerEpoch: number): NestHostCommand => ({
  _tag: "resume",
  boxId: "box-1",
  userId: "user-1",
  vmId: "vm-1",
  ownerEpoch,
  limits,
  publicUrl: "https://box-1.example.test",
  volumeRef: null,
  enrollToken: null,
})

describe("commands received before the lease lapsed or the link dropped", () => {
  test("a resume queued before a lease lapse does not run once the lease is renewed", async () => {
    const { manager, applied, open, started } = newManager("lapse")
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroy(1))
    await started
    const stale = manager.execute("cmd-stale", resume(1))
    manager.setLease(Date.now() - 1)
    manager.setLease(Date.now() + 60_000)
    open()
    await busy
    expect(await stale).toBeNull()
    expect(applied).toEqual(["destroy"])
  })

  test("a resume queued before a disconnect does not run after reconnect, and is not recorded", async () => {
    const { manager, applied, open, started } = newManager("disconnect")
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroy(1))
    await started
    const stale = manager.execute("cmd-stale", resume(1))
    manager.invalidateQueuedCommands()
    manager.setLease(Date.now() + 60_000)
    open()
    await busy
    expect(await stale).toBeNull()
    expect(applied).toEqual(["destroy"])
    expect(manager.pendingResults().map((outcome) => outcome.commandId)).toEqual(["cmd-busy"])
  })

  test("a resend of the same commandId after reconnect runs once and is recorded", async () => {
    const { manager, applied, open, started } = newManager("resend")
    manager.setLease(Date.now() + 60_000)
    const busy = manager.execute("cmd-busy", destroy(1))
    await started
    const stale = manager.execute("cmd-resume", resume(1))
    manager.invalidateQueuedCommands()
    manager.setLease(Date.now() + 60_000)
    const resent = manager.execute("cmd-resume", resume(1))
    open()
    await busy
    expect(await stale).toBeNull()
    expect((await resent)?.outcome).toMatchObject({ commandId: "cmd-resume", ok: true })
    expect(applied).toEqual(["destroy", "resume"])
    expect(manager.pendingResults().filter((outcome) => outcome.commandId === "cmd-resume")).toHaveLength(1)
  })

  test("a lapse the policy tick already fenced does not refuse a resend that arrives with the renewal", async () => {
    const { manager, applied, open } = newManager("tick-lapse")
    manager.setLease(Date.now() + 60_000)
    manager.setLease(Date.now() - 1)
    ;(manager as unknown as { tick: () => void }).tick()
    const resent = manager.execute("cmd-resend", resume(1))
    manager.setLease(Date.now() + 60_000)
    open()
    expect((await resent)?.outcome).toMatchObject({ commandId: "cmd-resend", ok: true })
    expect(applied).toEqual(["resume"])
  })

  test("a command already answered returns its stored outcome across a reconnect, without running again", async () => {
    const { manager, applied, open } = newManager("dedupe")
    open()
    manager.setLease(Date.now() + 60_000)
    const first = await manager.execute("cmd-done", destroy(1))
    manager.invalidateQueuedCommands()
    manager.setLease(Date.now() + 60_000)
    const again = await manager.execute("cmd-done", destroy(1))
    expect(again?.outcome).toEqual(first?.outcome)
    expect(applied).toEqual(["destroy"])
  })
})

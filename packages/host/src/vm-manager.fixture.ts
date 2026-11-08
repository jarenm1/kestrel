import type { NestHostCommand } from "@cloudagents/protocol"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostConfig } from "./config"
import { ensureStateDirs, stateLayout } from "./state-store"
import { VmManager, type VmEvents } from "./vm-manager"

const GIB = 1024 * 1024 * 1024

export const testLimits = { maxVcpus: 2, maxMemoryBytes: 2 * GIB, gpu: "none" as const, volumeBytes: GIB }

export const destroyCommand = (ownerEpoch: number): NestHostCommand => ({ _tag: "destroy", boxId: "box-1", ownerEpoch })

export const resumeCommand = (ownerEpoch: number): NestHostCommand => ({
  _tag: "resume",
  boxId: "box-1",
  userId: "user-1",
  vmId: "vm-1",
  ownerEpoch,
  limits: testLimits,
  publicUrl: "https://box-1.example.test",
  volumeRef: null,
  enrollToken: null,
})

export interface TestManager {
  readonly manager: VmManager
  /** Every command kind `apply` was asked to run, in order. */
  readonly applied: string[]
  /** Resolves once a `destroy` is running and blocked, so commands sent next queue behind it. */
  readonly started: Promise<void>
  /** Lets the blocked `destroy` finish. */
  readonly open: () => void
  /** Where the lease is persisted, for a test that makes the write fail. */
  readonly leasePath: string
  /**
   * The state directory. A test makes writes fail by making it read-only, which leaves the command store readable.
   * This needs a non-root user: root writes through a read-only directory.
   */
  readonly stateDir: string
  readonly dispose: () => void
}

/**
 * A real VmManager on a temporary state dir, with `apply` replaced by a recorder. `destroy` runs and blocks until `open()`,
 * the way a long park or backup would hold a box's queue on a real host.
 */
export const newTestManager = (): TestManager => {
  const root = mkdtempSync(join(tmpdir(), "vm-manager-test-"))
  const guestDir = join(root, "guest")
  mkdirSync(guestDir)
  writeFileSync(join(guestDir, "manifest.json"), JSON.stringify({ imageId: "image-1", kernel: "vmlinux", initrd: null, store: "store", cmdline: "cmdline" }))
  writeFileSync(join(guestDir, "cmdline"), "console=ttyS0\n")
  const stateDir = join(root, "state")
  mkdirSync(stateDir)
  const layout = stateLayout(stateDir)
  ensureStateDirs(layout)

  const events: VmEvents = { vm: () => {}, wakeRequest: () => {}, error: () => {}, notice: () => {} }
  const config = {
    hostId: "host-1",
    stateDir,
    guestImageDir: guestDir,
    volumeTool: "kestrel-volume",
    volumeStore: "file:///unused",
    volumeKeyFile: null,
    capacity: { vcpus: 4, memoryBytes: 8 * GIB },
    gpus: [],
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
  return {
    manager,
    applied,
    started,
    open,
    leasePath: layout.leasePath,
    stateDir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

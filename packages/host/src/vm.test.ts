import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HostError } from "./errors"
import { verifyVolumeIdentity } from "./disk"
import { eventsPath, initHost, listVmIds, readVm, vmPaths, writeVm } from "./state-store"
import { createVm, destroyVm, FORCED_STOP_NOTE, startVm, stopVm } from "./vm"
import { killIfAlive, makeContext, makeTempDir, writeFakeLauncher, writeStoppedVm, type TempDir } from "./test-support"

/** Create/start/stop need mkfs.ext4 on PATH. Those tests are skipped when it is absent. */
const HAS_MKFS = Bun.which("mkfs.ext4") !== null

let tmp: TempDir
let dir: string
let launcher: string
const warnings: string[] = []

beforeEach(() => {
  tmp = makeTempDir("vm")
  dir = tmp.path
  launcher = writeFakeLauncher(dir)
  warnings.length = 0
})

afterEach(() => {
  for (const vmId of listVmIds(dir)) killIfAlive(readVm(dir, vmId))
  tmp.dispose()
})

const eventStates = (): string[] =>
  readFileSync(eventsPath(dir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).state as string)

describe("destroy", () => {
  test("refuses a running VM", async () => {
    const vm = writeStoppedVm(dir)
    writeVm(dir, { ...vm, state: "running" })
    const ctx = makeContext(dir, launcher, process.env, warnings)
    await expect(destroyVm(ctx, vm.vmId)).rejects.toThrow(/stop it first/)
    expect(readVm(dir, vm.vmId)?.state).toBe("running")
    expect(existsSync(eventsPath(dir))).toBe(false)
  })

  test("a stopped VM is removed: artifacts gone, tombstone kept, deleted event written", async () => {
    const vm = writeStoppedVm(dir)
    const ctx = makeContext(dir, launcher, process.env, warnings)

    const deleted = await destroyVm(ctx, vm.vmId)

    expect(deleted.state).toBe("deleted")
    expect(readVm(dir, vm.vmId)?.state).toBe("deleted")
    expect(existsSync(vmPaths(dir, vm.vmId).osDisk)).toBe(false)
    expect(existsSync(vmPaths(dir, vm.vmId).dataDisk)).toBe(false)
    expect(eventStates()).toEqual(["deleted"])
  })

  test("a deleted VM cannot be destroyed again", async () => {
    const vm = writeStoppedVm(dir)
    const ctx = makeContext(dir, launcher, process.env, warnings)
    await destroyVm(ctx, vm.vmId)
    await expect(destroyVm(ctx, vm.vmId)).rejects.toThrow(/already deleted/)
  })
})

describe("stop", () => {
  test("stopping a VM that never reached running writes no parked record", async () => {
    const vm = writeStoppedVm(dir)
    writeVm(dir, { ...vm, state: "starting" })
    const ctx = makeContext(dir, launcher, process.env, warnings)

    await expect(stopVm(ctx, vm.vmId, { timeoutMs: 1000, force: false })).resolves.toBe("stopped")

    expect(readVm(dir, vm.vmId)?.state).toBe("stopped")
    expect(existsSync(eventsPath(dir))).toBe(false)
  })
})

describe("create and start refusals", () => {
  test("create refuses an OS image that is missing", () => {
    const ctx = makeContext(dir, launcher, process.env, warnings)
    expect(() =>
      createVm(ctx, {
        userId: "alice",
        osImage: join(dir, "missing.raw"),
        shape: { cpus: 2, memoryMb: 2048 },
        volumeGb: 1,
      }),
    ).toThrow(HostError)
  })

  test("start refuses a data disk with no filesystem and never formats it", async () => {
    const vm = writeStoppedVm(dir)
    const ctx = makeContext(dir, launcher, process.env, warnings)
    await expect(startVm(ctx, vm.vmId)).rejects.toThrow(/blkid found no filesystem/)
    expect(readVm(dir, vm.vmId)?.state).toBe("stopped")
    expect(existsSync(eventsPath(dir))).toBe(false)
  })

  test("start refuses a VM whose record says running", async () => {
    const vm = writeStoppedVm(dir)
    writeVm(dir, { ...vm, state: "running" })
    const ctx = makeContext(dir, launcher, process.env, warnings)
    await expect(startVm(ctx, vm.vmId)).rejects.toThrow(/only a stopped VM/)
  })
})

describe.skipIf(!HAS_MKFS)("with a real data volume (mkfs.ext4 on PATH)", () => {
  const osImage = (): string => {
    const path = join(dir, "base.raw")
    writeFileSync(path, "base-os-image")
    return path
  }

  const createFixture = (): string => {
    initHost(dir)
    const ctx = makeContext(dir, launcher, process.env, warnings)
    return createVm(ctx, { userId: "alice", osImage: osImage(), shape: { cpus: 2, memoryMb: 2048 }, volumeGb: 1 })
  }

  test("create copies the OS image, formats the volume, and records its identity", () => {
    const vmId = createFixture()
    const vm = readVm(dir, vmId)
    expect(vm?.state).toBe("stopped")
    expect(vm?.sequence).toBe(0)
    expect(vm?.volume.label).toBe("kestrel-data")
    expect(readFileSync(vmPaths(dir, vmId).osDisk, "utf8")).toBe("base-os-image")
    expect(() => verifyVolumeIdentity(vmPaths(dir, vmId).dataDisk, vm!.volume)).not.toThrow()
  })

  test("start refuses a volume whose uuid does not match the record", async () => {
    const vmId = createFixture()
    const vm = readVm(dir, vmId)!
    writeVm(dir, { ...vm, volume: { ...vm.volume, uuid: randomUUID() } })
    const ctx = makeContext(dir, launcher, process.env, warnings)
    await expect(startVm(ctx, vmId)).rejects.toThrow(/identity mismatch/)
    expect(readVm(dir, vmId)?.state).toBe("stopped")
    expect(existsSync(eventsPath(dir))).toBe(false)
  })

  test("start, then clean stop, emits running then parked and destroy then emits deleted", async () => {
    const vmId = createFixture()
    const ctx = makeContext(dir, launcher, process.env, warnings)

    const running = await startVm(ctx, vmId)
    expect(running.state).toBe("running")
    expect(running.process?.pid).toBeGreaterThan(0)
    expect(eventStates()).toEqual(["running"])

    expect(await stopVm(ctx, vmId, { timeoutMs: 10_000, force: false })).toBe("stopped")
    expect(readVm(dir, vmId)?.state).toBe("stopped")
    expect(eventStates()).toEqual(["running", "parked"])

    await destroyVm(ctx, vmId)
    expect(eventStates()).toEqual(["running", "parked", "deleted"])
  })

  test("a launcher that dies early leaves the VM stopped with the log tail and no event", async () => {
    const vmId = createFixture()
    const ctx = makeContext(dir, launcher, { ...process.env, FAKE_QEMU_MODE: "exit-immediately" }, warnings)

    await expect(startVm(ctx, vmId)).rejects.toThrow(HostError)
    const vm = readVm(dir, vmId)
    expect(vm?.state).toBe("stopped")
    expect(vm?.lastError).toContain("boom")
    expect(existsSync(eventsPath(dir))).toBe(false)
  })

  test("a guest that ignores powerdown keeps the VM stopping; retry with --force sends quit", async () => {
    const vmId = createFixture()
    const env = { ...process.env, FAKE_QEMU_MODE: "ignore-powerdown" }
    const ctx = makeContext(dir, launcher, env, warnings)
    await startVm(ctx, vmId)

    await expect(stopVm(ctx, vmId, { timeoutMs: 1000, force: false })).rejects.toThrow(HostError)
    const stuck = readVm(dir, vmId)
    expect(stuck?.state).toBe("stopping")
    expect(stuck?.lastError).toContain("did not power off")
    expect(eventStates()).toEqual(["running"])

    expect(await stopVm(ctx, vmId, { timeoutMs: 1000, force: true })).toBe("forced")
    const forced = readVm(dir, vmId)
    expect(forced?.state).toBe("stopped")
    expect(forced?.lastError).toBe(FORCED_STOP_NOTE)
    expect(eventStates()).toEqual(["running", "parked"])
    expect(warnings.some((message) => message.includes("forcing VM"))).toBe(true)
  })
})

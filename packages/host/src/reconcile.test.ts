import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { acquireVmLock, withVmLock } from "./lock"
import { reconcileAll, reconcileLocked } from "./reconcile"
import { GONE_AT_RECONCILE } from "./vm"
import { vmProcessName } from "./vm-state"
import { eventsPath, readVm, vmPaths, writeVm } from "./state-store"
import { makeContext, makeTempDir, writeStoppedVm, type TempDir } from "./test-support"
import type { VmRecord } from "./schema"

let tmp: TempDir
let dir: string
const warnings: string[] = []

beforeEach(() => {
  tmp = makeTempDir("reconcile")
  dir = tmp.path
  warnings.length = 0
})

afterEach(() => tmp.dispose())

/** A pid whose process has exited and been reaped: nothing owns it now. */
const exitedPid = (): number => {
  const result = spawnSync(process.execPath, ["-e", "0"])
  if (typeof result.pid !== "number") throw new Error("spawnSync returned no pid")
  return result.pid
}

const eventStates = (): string[] =>
  readFileSync(eventsPath(dir), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).state as string)

describe("reconcile", () => {
  test("a running VM whose process is dead becomes stopped and emits parked", async () => {
    const vm = writeStoppedVm(dir)
    writeVm(dir, {
      ...vm,
      state: "running",
      runningReported: true,
      process: { pid: exitedPid(), startTime: 1, name: vmProcessName(vm.vmId) },
    })
    const ctx = makeContext(dir, "/nonexistent", {}, warnings)

    const change = await withVmLock(vmPaths(dir, vm.vmId).dir, () => reconcileLocked(ctx, vm.vmId))

    expect(change).toEqual({ vmId: vm.vmId, from: "running", to: "stopped", reason: GONE_AT_RECONCILE })
    const after = readVm(dir, vm.vmId)
    expect(after?.state).toBe("stopped")
    expect(after?.lastError).toBe(GONE_AT_RECONCILE)
    expect(eventStates()).toEqual(["parked"])
  })

  test("a stopped VM is left alone", async () => {
    const vm = writeStoppedVm(dir)
    const ctx = makeContext(dir, "/nonexistent", {}, warnings)
    expect(await reconcileLocked(ctx, vm.vmId)).toBeNull()
    expect(existsSync(eventsPath(dir))).toBe(false)
  })

  test("a destroying VM with no live process finishes the destroy", async () => {
    const vm = writeStoppedVm(dir)
    writeVm(dir, { ...vm, state: "destroying" })
    const ctx = makeContext(dir, "/nonexistent", {}, warnings)

    const change = await withVmLock(vmPaths(dir, vm.vmId).dir, () => reconcileLocked(ctx, vm.vmId))

    expect(change?.to).toBe("deleted")
    expect(readVm(dir, vm.vmId)?.state).toBe("deleted")
    expect(existsSync(vmPaths(dir, vm.vmId).osDisk)).toBe(false)
    expect(eventStates()).toEqual(["deleted"])
  })

  test("reconcileAll clears a stale lock and reconciles the dead VM", async () => {
    const vm: VmRecord = writeStoppedVm(dir)
    writeVm(dir, { ...vm, state: "running", process: { pid: exitedPid(), startTime: 1, name: vmProcessName(vm.vmId) } })
    writeFileSync(
      join(vmPaths(dir, vm.vmId).dir, "lock"),
      JSON.stringify({ pid: exitedPid(), startTime: 1, token: "11111111-1111-4111-8111-111111111111" }),
    )
    const ctx = makeContext(dir, "/nonexistent", {}, warnings)

    const changes = await reconcileAll(ctx)

    expect(changes.map((change) => change.to)).toEqual(["stopped"])
    const lock = acquireVmLock(vmPaths(dir, vm.vmId).dir)
    lock.release()
  })
})

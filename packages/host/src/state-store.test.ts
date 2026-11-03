import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "./fs-atomic"
import { initHost, listVmIds, readHost, readVm, requireVm, requireVmId, vmPaths, writeVm } from "./state-store"
import type { VmRecord } from "./schema"
import { makeTempDir, writeStoppedVm, type TempDir } from "./test-support"

let tmp: TempDir
let dir: string

beforeEach(() => {
  tmp = makeTempDir("state")
  dir = tmp.path
})

afterEach(() => tmp.dispose())

describe("host.json", () => {
  test("is created once and reused", () => {
    const first = initHost(dir)
    const second = initHost(dir)
    expect(second.hostId).toBe(first.hostId)
    expect(readHost(dir)).toEqual(first)
    expect(first.schemaVersion).toBe(1)
  })
})

describe("vm.json", () => {
  test("round-trips through readVm", () => {
    const vm = writeStoppedVm(dir)
    expect(readVm(dir, vm.vmId)).toEqual(vm)
    expect(requireVm(dir, vm.vmId)).toEqual(vm)
  })

  test("readVm returns null for an unknown VM and requireVm throws", () => {
    const unknown = randomUUID()
    expect(readVm(dir, unknown)).toBeNull()
    expect(() => requireVm(dir, unknown)).toThrow(/no such VM/)
  })

  test("writeVm replaces the record and leaves no temporary files behind", () => {
    const vm = writeStoppedVm(dir)
    const updated: VmRecord = { ...vm, sequence: 1, lastError: "example" }
    writeVm(dir, updated)
    expect(readVm(dir, vm.vmId)).toEqual(updated)
    const entries = readdirSync(vmPaths(dir, vm.vmId).dir).sort()
    expect(entries).toEqual(["data.raw", "os.raw", "vm.json"])
  })

  test("writeVm refuses a record with unknown keys and keeps the previous file", () => {
    const vm = writeStoppedVm(dir)
    const polluted = { ...vm, bogus: true } as unknown as VmRecord
    expect(() => writeVm(dir, polluted)).toThrow()
    expect(readVm(dir, vm.vmId)).toEqual(vm)
  })

  test("a corrupt vm.json is an error, not a silent null", () => {
    const vm = writeStoppedVm(dir)
    writeFileSync(vmPaths(dir, vm.vmId).vmJson, "{not json")
    expect(() => readVm(dir, vm.vmId)).toThrow()
  })

  test("listVmIds ignores entries that are not VM ids", () => {
    const vm = writeStoppedVm(dir)
    mkdirSync(join(dir, "vms", "junk"), { recursive: true })
    expect(listVmIds(dir)).toEqual([vm.vmId])
  })

  test("requireVmId rejects path-like input", () => {
    expect(() => requireVmId("../escape")).toThrow()
    expect(() => requireVmId("not-a-uuid")).toThrow()
  })
})

describe("writeFileAtomic", () => {
  test("replaces content and leaves only the target file", () => {
    const target = join(dir, "data.json")
    writeFileAtomic(target, "first")
    writeFileAtomic(target, "second")
    expect(readFileSync(target, "utf8")).toBe("second")
    expect(readdirSync(dir)).toEqual(["data.json"])
  })
})

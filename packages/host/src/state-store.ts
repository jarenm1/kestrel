import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { Schema } from "effect"
import { HostError } from "./errors"
import { createFileExclusive, writeFileAtomic } from "./fs-atomic"
import { HostRecord, STRICT, Uuid, VmRecord } from "./schema"

/**
 * On-disk layout (see README.md):
 *   <stateDir>/host.json
 *   <stateDir>/events.jsonl
 *   <stateDir>/vms/<vmId>/{vm.json,lock,os.raw,data.raw,console.sock,console.log,qmp.sock,launcher.log}
 */

export const resolveStateDir = (env: NodeJS.ProcessEnv): string => {
  if (env.KESTREL_HOST_HOME) return env.KESTREL_HOST_HOME
  const xdg = env.XDG_STATE_HOME
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state")
  return join(base, "kestrel-host")
}

export interface VmPaths {
  readonly dir: string
  readonly vmJson: string
  readonly lock: string
  readonly osDisk: string
  readonly dataDisk: string
  readonly consoleSock: string
  readonly consoleLog: string
  readonly qmpSock: string
  readonly launcherLog: string
}

export const eventsPath = (stateDir: string): string => join(stateDir, "events.jsonl")

/** Throws HostError unless `vmId` is a UUID v4, so it is safe to use as a path component. */
export const requireVmId = (vmId: string): string => {
  if (!Schema.is(Uuid)(vmId)) throw new HostError(`invalid VM id: ${vmId}`)
  return vmId
}

export const vmPaths = (stateDir: string, vmId: string): VmPaths => {
  const dir = join(stateDir, "vms", requireVmId(vmId))
  return {
    dir,
    vmJson: join(dir, "vm.json"),
    lock: join(dir, "lock"),
    osDisk: join(dir, "os.raw"),
    dataDisk: join(dir, "data.raw"),
    consoleSock: join(dir, "console.sock"),
    consoleLog: join(dir, "console.log"),
    qmpSock: join(dir, "qmp.sock"),
    launcherLog: join(dir, "launcher.log"),
  }
}

const decodeFile = <A, I>(schema: Schema.Schema<A, I>, path: string): A => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new HostError(`cannot read ${path}: ${(error as Error).message}`)
  }
  try {
    return Schema.decodeUnknownSync(schema, STRICT)(parsed)
  } catch (error) {
    throw new HostError(`invalid ${path}: ${(error as Error).message}`)
  }
}

/** Creates the state directory layout if missing and returns host.json, generating the host id once. */
export const initHost = (stateDir: string): HostRecord => {
  mkdirSync(join(stateDir, "vms"), { recursive: true, mode: 0o700 })
  const path = join(stateDir, "host.json")
  const record: HostRecord = { schemaVersion: 1, hostId: randomUUID() }
  createFileExclusive(path, `${JSON.stringify(record, null, 2)}\n`)
  return decodeFile(HostRecord, path)
}

export const readHost = (stateDir: string): HostRecord => decodeFile(HostRecord, join(stateDir, "host.json"))

/** Returns the VM record, or null when the VM does not exist. */
export const readVm = (stateDir: string, vmId: string): VmRecord | null => {
  const path = vmPaths(stateDir, vmId).vmJson
  if (!existsSync(path)) return null
  const record = decodeFile(VmRecord, path)
  if (record.vmId !== vmId) throw new HostError(`${path} records vmId ${record.vmId}`)
  return record
}

/** Like readVm, but a missing VM is an operational error. */
export const requireVm = (stateDir: string, vmId: string): VmRecord => {
  const record = readVm(stateDir, vmId)
  if (record === null) throw new HostError(`no such VM: ${vmId}`)
  return record
}

/** Validates the record and atomically replaces vm.json. */
export const writeVm = (stateDir: string, vm: VmRecord): void => {
  const valid = Schema.decodeUnknownSync(VmRecord, STRICT)(vm)
  writeFileAtomic(vmPaths(stateDir, valid.vmId).vmJson, `${JSON.stringify(valid, null, 2)}\n`)
}

/** Sorted ids of the VM directories that hold a vm.json. Entries that are not VM ids are ignored. */
export const listVmIds = (stateDir: string): string[] => {
  const vmsDir = join(stateDir, "vms")
  if (!existsSync(vmsDir)) return []
  return readdirSync(vmsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && Schema.is(Uuid)(entry.name))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(vmsDir, name, "vm.json")))
    .sort()
}

/**
 * Deletes everything in the VM directory except vm.json (the tombstone) and the lock file. Refuses unless
 * `<stateDir>/vms/<vmId>` is a real directory (not a symlink).
 */
export const removeVmArtifacts = (stateDir: string, vmId: string): void => {
  const paths = vmPaths(stateDir, vmId)
  if (!existsSync(paths.dir)) return
  if (!lstatSync(paths.dir).isDirectory()) throw new HostError(`refusing to clear non-directory ${paths.dir}`)
  for (const name of readdirSync(paths.dir)) {
    if (name === "vm.json" || name === "lock") continue
    rmSync(join(paths.dir, name), { recursive: true, force: true })
  }
}

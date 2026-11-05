import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { HostError, errorMessage } from "./errors"
import { writeFileAtomic } from "./fs-atomic"
import { CommandOutcome, STRICT, VmRecord } from "./schema"

/** Commands remembered for dedupe; a resent command older than this is treated as new. */
export const MAX_COMMAND_OUTCOMES = 512

/**
 * On-disk layout under the state directory:
 *
 *   commands.json                 recent command outcomes (dedupe + unreported results)
 *   templates/<imageId>/          clone source: config.json, state.json, memory-ranges
 *   vms/<boxId>/vm.json           the VM record (a destroyed VM keeps a tombstone)
 *   vms/<boxId>/volume.raw        local copy of the volume (sparse raw file)
 *   vms/<boxId>/swap.raw          local swap disk, recreated per VM start, never backed up
 *   vms/<boxId>/snapshot.<gen>/   memory image of a suspended VM
 *   vms/<boxId>/restore/          per-restore working copy handed to Cloud Hypervisor
 *   vms/<boxId>/api.sock          Cloud Hypervisor API socket
 *   vms/<boxId>/vsock.sock        vsock socket (hybrid vsock to the guest agent)
 *   vms/<boxId>/console.log       serial console output
 *   meter/outbox.jsonl            meter records not yet accepted by the control plane
 *   meter/rejected.jsonl          meter records the control plane refused permanently
 *   meter/state.json              meter sampler state (survives restarts)
 */
export interface StateLayout {
  readonly root: string
  readonly commandsPath: string
  readonly templatesDir: string
  readonly vmsDir: string
  readonly meterDir: string
  /** The control plane's lease, read by the fence watchdog. */
  readonly leasePath: string
}

export const stateLayout = (root: string): StateLayout => ({
  root,
  commandsPath: join(root, "commands.json"),
  templatesDir: join(root, "templates"),
  vmsDir: join(root, "vms"),
  meterDir: join(root, "meter"),
  leasePath: join(root, "lease.json"),
})

/** A box id names a directory under `vms/`; anything else is refused before a path is built. */
const BOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const isBoxId = (boxId: string): boolean => BOX_ID_PATTERN.test(boxId)

export const vmDir = (layout: StateLayout, boxId: string): string => join(layout.vmsDir, boxId)

export const vmPaths = (layout: StateLayout, boxId: string) => {
  const dir = vmDir(layout, boxId)
  return {
    dir,
    record: join(dir, "vm.json"),
    volume: join(dir, "volume.raw"),
    swap: join(dir, "swap.raw"),
    restore: join(dir, "restore"),
    apiSocket: join(dir, "api.sock"),
    vsockSocket: join(dir, "vsock.sock"),
    console: join(dir, "console.log"),
    snapshot: (gen: number) => join(dir, `snapshot.${gen}`),
  }
}

export const ensureStateDirs = (layout: StateLayout): void => {
  mkdirSync(layout.vmsDir, { recursive: true, mode: 0o700 })
  mkdirSync(layout.templatesDir, { recursive: true, mode: 0o700 })
  mkdirSync(layout.meterDir, { recursive: true, mode: 0o700 })
}

const decodeJsonFile = <A, I>(schema: Schema.Schema<A, I>, path: string): A => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new HostError(`cannot read ${path}: ${errorMessage(error)}`)
  }
  const decoded = Schema.decodeUnknownEither(schema)(json, STRICT)
  if (decoded._tag === "Left") throw new HostError(`invalid ${path}: ${String(decoded.left)}`)
  return decoded.right
}

export const readVm = (layout: StateLayout, boxId: string): VmRecord | null => {
  const path = vmPaths(layout, boxId).record
  return existsSync(path) ? decodeJsonFile(VmRecord, path) : null
}

export const writeVm = (layout: StateLayout, record: VmRecord): void => {
  const paths = vmPaths(layout, record.boxId)
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  writeFileAtomic(paths.record, `${JSON.stringify(record, null, 2)}\n`)
}

/** Every VM directory with a record, tombstones included. */
export const listVms = (layout: StateLayout): VmRecord[] => {
  if (!existsSync(layout.vmsDir)) return []
  const records: VmRecord[] = []
  for (const entry of readdirSync(layout.vmsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const record = readVm(layout, entry.name)
    if (record !== null) records.push(record)
  }
  return records
}

export const removeVmDir = (layout: StateLayout, boxId: string): void => {
  rmSync(vmDir(layout, boxId), { recursive: true, force: true })
}

export const readCommands = (layout: StateLayout): CommandOutcome[] => {
  if (!existsSync(layout.commandsPath)) return []
  const decoded = decodeJsonFile(Schema.Array(CommandOutcome), layout.commandsPath)
  return [...decoded]
}

const writeCommands = (layout: StateLayout, outcomes: readonly CommandOutcome[]): void => {
  writeFileAtomic(layout.commandsPath, `${JSON.stringify(outcomes, null, 2)}\n`)
}

/** Records an outcome, replacing any earlier one for the same commandId, keeping the newest MAX_COMMAND_OUTCOMES. */
export const recordCommand = (layout: StateLayout, outcome: CommandOutcome): void => {
  const kept = readCommands(layout).filter((entry) => entry.commandId !== outcome.commandId)
  kept.push(outcome)
  writeCommands(layout, kept.slice(-MAX_COMMAND_OUTCOMES))
}

export const findCommand = (layout: StateLayout, commandId: string): CommandOutcome | null =>
  readCommands(layout).find((entry) => entry.commandId === commandId) ?? null

/** Marks outcomes as delivered to the control plane. */
export const markCommandsReported = (layout: StateLayout, commandIds: readonly string[]): void => {
  const ids = new Set(commandIds)
  writeCommands(
    layout,
    readCommands(layout).map((entry) => (ids.has(entry.commandId) ? { ...entry, reported: true } : entry)),
  )
}

export const pendingCommands = (layout: StateLayout): CommandOutcome[] =>
  readCommands(layout).filter((entry) => !entry.reported)

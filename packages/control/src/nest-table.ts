/**
 * Nest host and box state in the Hub's SQLite database. A Nest box is a `user_boxes` row plus a `nest_boxes` row
 * holding its placement, epoch and in-flight command. Hosts are the meter host registrations plus a `nest_hosts`
 * row written at the host's first `hello`.
 */
import { Schema } from "effect"
import { NestHostCapacity, NestHostCommand, NestLimits, NestVmState } from "@cloudagents/protocol"
import type { FleetSql } from "./sql"

/** Creates `nest_hosts` and `nest_boxes` when missing. */
export const ensureNestTables = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS nest_hosts (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    image_id TEXT NOT NULL,
    capacity TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS nest_boxes (
    box_id TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    host_id TEXT,
    vm_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,
    limits TEXT NOT NULL,
    volume_ref TEXT,
    backed_up_at INTEGER,
    image_id TEXT,
    vcpus INTEGER NOT NULL,
    memory_bytes INTEGER NOT NULL,
    gpus INTEGER NOT NULL,
    wake_wanted INTEGER NOT NULL,
    enroll_hash TEXT,
    enroll_expires_at INTEGER,
    pending_id TEXT,
    pending_kind TEXT,
    pending_command TEXT,
    pending_deadline INTEGER,
    create_failed INTEGER NOT NULL DEFAULT 0,
    retry_kind TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    stale_since INTEGER
  )`)
  // Tables created before `create_failed`, the retry columns or `stale_since` get them here; existing boxes
  // have nothing owed and nothing observed stale.
  const boxColumns = sql.exec<{ name: string }>("PRAGMA table_info(nest_boxes)").toArray()
  if (!boxColumns.some((c) => c.name === "create_failed")) {
    sql.exec("ALTER TABLE nest_boxes ADD COLUMN create_failed INTEGER NOT NULL DEFAULT 0")
  }
  if (!boxColumns.some((c) => c.name === "retry_kind")) sql.exec("ALTER TABLE nest_boxes ADD COLUMN retry_kind TEXT")
  if (!boxColumns.some((c) => c.name === "retry_count")) {
    sql.exec("ALTER TABLE nest_boxes ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0")
  }
  if (!boxColumns.some((c) => c.name === "stale_since")) sql.exec("ALTER TABLE nest_boxes ADD COLUMN stale_since INTEGER")
  sql.exec(`CREATE INDEX IF NOT EXISTS nest_boxes_host ON nest_boxes (host_id)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS nest_boxes_deadline ON nest_boxes (pending_deadline)`)
}

/** One `nest_boxes` row as the control plane works with it. */
export type NestBoxRow = {
  boxId: string
  login: string
  hostId: string | null
  vmId: string
  ownerEpoch: number
  state: NestVmState
  limits: NestLimits
  volumeRef: string | null
  backedUpAt: number | null
  imageId: string | null
  vcpus: number
  memoryBytes: number
  gpus: number
  wakeWanted: boolean
  enrollHash: string | null
  enrollExpiresAt: number | null
  pendingId: string | null
  pendingKind: NestHostCommand["_tag"] | null
  pendingCommand: StoredNestCommand | null
  pendingDeadline: number | null
  /** The create command failed or timed out: the box has no VM and needs the owner to delete it. */
  createFailed: boolean
  /** A create, park or destroy the host refused for a lapse, owed a resend at the next lease renewal; null when none is owed. */
  retryKind: "create" | "park" | "destroy" | null
  /** Lapse refusals in a row for the owed command; reset by a command that ran. */
  retryCount: number
  /**
   * When the drain first saw the box's image differ from its host's (ms); null while they match or the box is not
   * running or suspended. A running box gets this long as grace before it is parked; a suspended one is parked at once.
   */
  staleSince: number | null
}

/** A `nest_hosts` row; `capacity` is what the host last reported. */
export type NestHostRow = {
  id: string
  slug: string
  agentVersion: string
  imageId: string
  capacity: NestHostCapacity
  lastSeenAt: string
}

type NestBoxSqlRow = {
  boxId: string
  login: string
  hostId: string | null
  vmId: string
  ownerEpoch: number
  state: string
  limits: string
  volumeRef: string | null
  backedUpAt: number | null
  imageId: string | null
  vcpus: number
  memoryBytes: number
  gpus: number
  wakeWanted: number
  enrollHash: string | null
  enrollExpiresAt: number | null
  pendingId: string | null
  pendingKind: string | null
  pendingCommand: string | null
  pendingDeadline: number | null
  createFailed: number
  retryKind: string | null
  retryCount: number
  staleSince: number | null
}

const NEST_BOX_COLUMNS = `nest_boxes.box_id AS boxId, nest_boxes.login, nest_boxes.host_id AS hostId,
  nest_boxes.vm_id AS vmId, nest_boxes.owner_epoch AS ownerEpoch,
  nest_boxes.state, nest_boxes.limits, nest_boxes.volume_ref AS volumeRef, nest_boxes.backed_up_at AS backedUpAt,
  nest_boxes.image_id AS imageId, nest_boxes.vcpus, nest_boxes.memory_bytes AS memoryBytes, nest_boxes.gpus,
  nest_boxes.wake_wanted AS wakeWanted, nest_boxes.enroll_hash AS enrollHash,
  nest_boxes.enroll_expires_at AS enrollExpiresAt, nest_boxes.pending_id AS pendingId,
  nest_boxes.pending_kind AS pendingKind, nest_boxes.pending_command AS pendingCommand,
  nest_boxes.pending_deadline AS pendingDeadline, nest_boxes.create_failed AS createFailed,
  nest_boxes.retry_kind AS retryKind, nest_boxes.retry_count AS retryCount, nest_boxes.stale_since AS staleSince`

const decodeLimits = Schema.decodeUnknownSync(NestLimits)
/**
 * A pending command as stored. A create keeps no enrollment token: a resend mints a fresh one, so the plaintext is
 * never written to the database.
 */
const StoredCreate = NestHostCommand.members[0].pipe(Schema.omit("enrollToken"))
export const StoredNestCommand = Schema.Union(StoredCreate, ...NestHostCommand.members.slice(1))
export type StoredNestCommand = typeof StoredNestCommand.Type
const decodeCommand = Schema.decodeUnknownSync(Schema.parseJson(StoredNestCommand))
const decodeCapacity = Schema.decodeUnknownSync(Schema.parseJson(NestHostCapacity))

const toBoxRow = (row: NestBoxSqlRow): NestBoxRow => ({
  boxId: row.boxId,
  login: row.login,
  hostId: row.hostId,
  vmId: row.vmId,
  ownerEpoch: row.ownerEpoch,
  state: row.state as NestVmState,
  limits: decodeLimits(JSON.parse(row.limits)),
  volumeRef: row.volumeRef,
  backedUpAt: row.backedUpAt,
  imageId: row.imageId,
  vcpus: row.vcpus,
  memoryBytes: row.memoryBytes,
  gpus: row.gpus,
  wakeWanted: row.wakeWanted !== 0,
  enrollHash: row.enrollHash,
  enrollExpiresAt: row.enrollExpiresAt,
  pendingId: row.pendingId,
  pendingKind: row.pendingKind as NestBoxRow["pendingKind"],
  pendingCommand: row.pendingCommand === null ? null : decodeCommand(row.pendingCommand),
  pendingDeadline: row.pendingDeadline,
  createFailed: row.createFailed !== 0,
  retryKind: row.retryKind as NestBoxRow["retryKind"],
  retryCount: row.retryCount,
  staleSince: row.staleSince,
})

export const insertNestBox = (sql: FleetSql, row: NestBoxRow): void => {
  sql.exec(
    `INSERT INTO nest_boxes (box_id, login, host_id, vm_id, owner_epoch, state, limits, volume_ref, backed_up_at,
      image_id, vcpus, memory_bytes, gpus, wake_wanted, enroll_hash, enroll_expires_at, pending_id, pending_kind,
      pending_command, pending_deadline, create_failed, retry_kind, retry_count, stale_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...nestBoxBindings(row),
  )
}

/** Writes every mutable column of a row. */
export const saveNestBox = (sql: FleetSql, row: NestBoxRow): void => {
  sql.exec(
    `UPDATE nest_boxes SET login = ?, host_id = ?, vm_id = ?, owner_epoch = ?, state = ?, limits = ?, volume_ref = ?,
      backed_up_at = ?, image_id = ?, vcpus = ?, memory_bytes = ?, gpus = ?, wake_wanted = ?, enroll_hash = ?,
      enroll_expires_at = ?, pending_id = ?, pending_kind = ?, pending_command = ?, pending_deadline = ?,
      create_failed = ?, retry_kind = ?, retry_count = ?, stale_since = ?
     WHERE box_id = ?`,
    ...nestBoxBindings(row).slice(1),
    row.boxId,
  )
}

const nestBoxBindings = (row: NestBoxRow): (string | number | null)[] => [
  row.boxId,
  row.login,
  row.hostId,
  row.vmId,
  row.ownerEpoch,
  row.state,
  JSON.stringify(row.limits),
  row.volumeRef,
  row.backedUpAt,
  row.imageId,
  row.vcpus,
  row.memoryBytes,
  row.gpus,
  row.wakeWanted ? 1 : 0,
  row.enrollHash,
  row.enrollExpiresAt,
  row.pendingId,
  row.pendingKind,
  row.pendingCommand === null ? null : JSON.stringify(row.pendingCommand),
  row.pendingDeadline,
  row.createFailed ? 1 : 0,
  row.retryKind,
  row.retryCount,
  row.staleSince,
]

export const deleteNestBox = (sql: FleetSql, boxId: string): void => {
  sql.exec("DELETE FROM nest_boxes WHERE box_id = ?", boxId)
}

export const nestBox = (sql: FleetSql, boxId: string): NestBoxRow | null => {
  const row = sql.exec<NestBoxSqlRow>(`SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE box_id = ?`, boxId).toArray()[0]
  return row === undefined ? null : toBoxRow(row)
}

/** The box whose in-flight command has this id, if any. */
export const nestBoxByPendingId = (sql: FleetSql, commandId: string): NestBoxRow | null => {
  const row = sql
    .exec<NestBoxSqlRow>(`SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE pending_id = ?`, commandId)
    .toArray()[0]
  return row === undefined ? null : toBoxRow(row)
}

export const nestBoxesOnHost = (sql: FleetSql, hostId: string): NestBoxRow[] =>
  sql
    .exec<NestBoxSqlRow>(`SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE host_id = ? ORDER BY box_id`, hostId)
    .toArray()
    .map(toBoxRow)

export const nestBoxesWanted = (sql: FleetSql): NestBoxRow[] =>
  sql
    .exec<NestBoxSqlRow>(`SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE wake_wanted = 1 ORDER BY box_id`)
    .toArray()
    .map(toBoxRow)

/** Boxes whose command deadline is at or before `now` (ms). */
export const nestBoxesDue = (sql: FleetSql, now: number): NestBoxRow[] =>
  sql
    .exec<NestBoxSqlRow>(
      `SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE pending_deadline IS NOT NULL AND pending_deadline <= ?`,
      now,
    )
    .toArray()
    .map(toBoxRow)

/** The earliest command deadline (ms), or null when no command is in flight with one. */
export const nextNestDeadline = (sql: FleetSql): number | null =>
  sql.exec<{ at: number | null }>("SELECT MIN(pending_deadline) AS at FROM nest_boxes").toArray()[0]?.at ?? null

/**
 * Running or suspended boxes on a host whose reported image is not the box's, with no command in flight: the rows the
 * image drain acts on. A parked box is absent — its host is already released and it adopts the new image on resume.
 */
export const nestStaleBoxes = (sql: FleetSql): NestBoxRow[] =>
  sql
    .exec<NestBoxSqlRow>(
      `SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes JOIN nest_hosts ON nest_hosts.id = nest_boxes.host_id
       WHERE nest_boxes.state IN ('running', 'suspended') AND nest_boxes.pending_id IS NULL
         AND nest_boxes.image_id IS NOT NULL AND nest_boxes.image_id <> nest_hosts.image_id`,
    )
    .toArray()
    .map(toBoxRow)

/**
 * Drops `stale_since` on rows no longer stale: not running or suspended, without a reported image, or matching their
 * host's image (a missing host row counts as matching, so a box re-placed elsewhere starts a fresh observation).
 */
export const clearStaleSince = (sql: FleetSql): void => {
  sql.exec(
    `UPDATE nest_boxes SET stale_since = NULL WHERE stale_since IS NOT NULL AND (
       state NOT IN ('running', 'suspended') OR image_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM nest_hosts WHERE nest_hosts.id = nest_boxes.host_id
                      AND nest_hosts.image_id <> nest_boxes.image_id))`,
  )
}

/** The earliest moment a running stale box's grace ends (ms), or null when none is being observed. */
export const nextStaleDeadline = (sql: FleetSql, graceMs: number): number | null =>
  sql
    .exec<{ at: number | null }>(
      `SELECT MIN(nest_boxes.stale_since + ?) AS at FROM nest_boxes JOIN nest_hosts ON nest_hosts.id = nest_boxes.host_id
       WHERE nest_boxes.state = 'running' AND nest_boxes.stale_since IS NOT NULL
         AND nest_boxes.image_id <> nest_hosts.image_id`,
      graceMs,
    )
    .toArray()[0]?.at ?? null

export const nestBoxesOfUser = (sql: FleetSql, login: string): NestBoxRow[] =>
  sql
    .exec<NestBoxSqlRow>(`SELECT ${NEST_BOX_COLUMNS} FROM nest_boxes WHERE login = ? ORDER BY box_id`, login)
    .toArray()
    .map(toBoxRow)

/** Boots a host is already committed to: a `create` in flight, or a parked box's `resume` sent to it. */
export const nestBootsOnHost = (sql: FleetSql, hostId: string): number =>
  sql
    .exec<{ boots: number }>(
      `SELECT COUNT(*) AS boots FROM nest_boxes WHERE host_id = ?
       AND (pending_kind = 'create' OR (pending_kind = 'resume' AND state = 'parked'))`,
      hostId,
    )
    .toArray()[0]?.boots ?? 0

export const upsertNestHost = (sql: FleetSql, host: NestHostRow): void => {
  sql.exec(
    `INSERT INTO nest_hosts (id, slug, agent_version, image_id, capacity, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, agent_version = excluded.agent_version,
       image_id = excluded.image_id, capacity = excluded.capacity, last_seen_at = excluded.last_seen_at`,
    host.id,
    host.slug,
    host.agentVersion,
    host.imageId,
    JSON.stringify(host.capacity),
    host.lastSeenAt,
  )
}

export const touchNestHost = (sql: FleetSql, hostId: string, lastSeenAt: string): void => {
  sql.exec("UPDATE nest_hosts SET last_seen_at = ? WHERE id = ?", lastSeenAt, hostId)
}

export const nestHostRow = (sql: FleetSql, hostId: string): NestHostRow | null => {
  const row = sql
    .exec<{ id: string; slug: string; agentVersion: string; imageId: string; capacity: string; lastSeenAt: string }>(
      "SELECT id, slug, agent_version AS agentVersion, image_id AS imageId, capacity, last_seen_at AS lastSeenAt FROM nest_hosts WHERE id = ?",
      hostId,
    )
    .toArray()[0]
  return row === undefined ? null : { ...row, capacity: decodeCapacity(row.capacity) }
}

export const nestHostRows = (sql: FleetSql): NestHostRow[] =>
  sql
    .exec<{ id: string; slug: string; agentVersion: string; imageId: string; capacity: string; lastSeenAt: string }>(
      "SELECT id, slug, agent_version AS agentVersion, image_id AS imageId, capacity, last_seen_at AS lastSeenAt FROM nest_hosts",
    )
    .toArray()
    .map((row) => ({ ...row, capacity: decodeCapacity(row.capacity) }))

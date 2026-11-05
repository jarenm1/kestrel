/**
 * Nest hosts and the usage records they post, in the Hub's SQLite database. Ingestion is all or nothing per batch:
 * records are checked against what is stored and against each other before any is written.
 */
import type { MeterHost, MeterIngestResult, MeterRecord } from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"

/** How long records are kept: a report may start no earlier than this many days before it runs. */
export const METER_RETENTION_DAYS = 90
const PURGE_BATCH = 500

/**
 * Creates `meter_hosts` and `meter_records` when missing. A record's `at` and `until` bound it in time: a lifecycle
 * record has both at its `observedAt`, and a usage record runs from `start` to `end`.
 */
export const ensureMeterTables = (sql: FleetSql): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS meter_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  sql.exec(`CREATE TABLE IF NOT EXISTS meter_records (
    host_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    vm_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    until TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (host_id, event_id)
  )`)
  sql.exec(`CREATE INDEX IF NOT EXISTS meter_records_vm ON meter_records (vm_id, kind, at)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS meter_records_kind_at ON meter_records (kind, at)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS meter_records_kind_until ON meter_records (kind, until)`)
}

/** JSON with object keys sorted at every depth, so equal records serialize identically. */
export const canonicalJson = (value: unknown): string => {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, sort((v as Record<string, unknown>)[key])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(value))
}

export const insertMeterHost = (
  sql: FleetSql,
  host: { id: string; name: string; secret: string; createdAt: string },
): void => {
  sql.exec(
    `INSERT INTO meter_hosts (id, name, secret, created_at) VALUES (?, ?, ?, ?)`,
    host.id,
    host.name,
    host.secret,
    host.createdAt,
  )
}

/** The host's secret, for the caller to compare; undefined for an unknown host. */
export const meterHostSecret = (sql: FleetSql, hostId: string): string | undefined =>
  sql.exec<{ secret: string }>(`SELECT secret FROM meter_hosts WHERE id = ?`, hostId).toArray()[0]?.secret

export const listMeterHosts = (sql: FleetSql): MeterHost[] =>
  sql
    .exec<{ id: string; name: string; created_at: string }>(
      `SELECT id, name, created_at FROM meter_hosts ORDER BY created_at, id`,
    )
    .toArray()
    .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }))

/** The earliest `at` a report may start with, for a retention window ending at `now`. */
export const meterRetentionCutoff = (now: string): string =>
  new Date(Date.parse(now) - METER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

/**
 * The records a report over `[from, through)` reads: lifecycle records and usage overlapping the window, plus each VM's
 * latest lifecycle record before `from`, which gives its state at `from`. Payloads were validated when stored.
 */
export const meterRecordsInWindow = (sql: FleetSql, from: string, through: string): MeterRecord[] => {
  const payloads = (query: string, ...bindings: string[]): string[] =>
    sql
      .exec<{ payload: string }>(query, ...bindings)
      .toArray()
      .map((row) => row.payload)
  const carried = payloads(
    `SELECT payload FROM meter_records r WHERE r.kind = 'lifecycle' AND r.at = (
       SELECT MAX(a.at) FROM meter_records a WHERE a.kind = 'lifecycle' AND a.vm_id = r.vm_id AND a.at < ?)`,
    from,
  )
  const lifecycle = payloads(
    `SELECT payload FROM meter_records WHERE kind = 'lifecycle' AND at >= ? AND at < ?`,
    from,
    through,
  )
  const usage = payloads(`SELECT payload FROM meter_records WHERE kind = 'usage' AND until > ? AND at < ?`, from, through)
  return [...carried, ...lifecycle, ...usage].map((payload) => JSON.parse(payload) as MeterRecord)
}

/**
 * Drops records that fell out of retention: usage that ended before the cutoff, and lifecycle records older than each
 * VM's latest one before it. Each VM keeps that latest one, which is the state a report starting at the cutoff reads.
 * At most `PURGE_BATCH` rows per call.
 */
export const purgeExpiredMeterRecords = (sql: FleetSql, now: string): void => {
  const cutoff = meterRetentionCutoff(now)
  sql.exec(
    `DELETE FROM meter_records WHERE rowid IN (
       SELECT r.rowid FROM meter_records r
       WHERE (r.kind = 'usage' AND r.until < ?)
          OR (r.kind = 'lifecycle' AND r.at < (
               SELECT MAX(a.at) FROM meter_records a WHERE a.kind = 'lifecycle' AND a.vm_id = r.vm_id AND a.at < ?))
       LIMIT ?
     )`,
    cutoff,
    cutoff,
    PURGE_BATCH,
  )
}

export type MeterIngestOutcome =
  | { ok: true; value: MeterIngestResult }
  | { ok: false; status: 403 | 409; tag: string; message: string }

const refuse = (status: 403 | 409, tag: string, message: string): MeterIngestOutcome => ({
  ok: false,
  status,
  tag,
  message,
})

/**
 * Stores `records` posted by `hostId`, skipping identical records already stored. Refuses the whole batch, storing
 * nothing, when a record names another host, reuses an eventId for different content, or gives a VM a second owner.
 * Overlapping usage is stored: reconciliation reports it.
 */
export const storeMeterRecords = (
  sql: FleetSql,
  hostId: string,
  records: readonly MeterRecord[],
  receivedAt: string,
): MeterIngestOutcome => {
  const pending = new Map<string, string>()
  const owners = new Map<string, string>()
  const fresh: { record: MeterRecord; payload: string }[] = []
  let duplicates = 0
  for (const record of records) {
    if (record.hostId !== hostId) {
      return refuse(403, "Forbidden", `record ${record.eventId} names host ${record.hostId}, not ${hostId}`)
    }
    const payload = canonicalJson(record)
    const stored =
      pending.get(record.eventId) ??
      sql
        .exec<{ payload: string }>(
          `SELECT payload FROM meter_records WHERE host_id = ? AND event_id = ?`,
          hostId,
          record.eventId,
        )
        .toArray()[0]?.payload
    if (stored !== undefined) {
      if (stored === payload) {
        duplicates += 1
        continue
      }
      return refuse(409, "Conflict", `conflicting event ID ${record.eventId}: stored with different content`)
    }
    pending.set(record.eventId, payload)
    const owner =
      owners.get(record.vmId) ??
      sql
        .exec<{ user_id: string }>(`SELECT user_id FROM meter_records WHERE vm_id = ? LIMIT 1`, record.vmId)
        .toArray()[0]?.user_id
    if (owner !== undefined && owner !== record.userId) {
      return refuse(409, "Conflict", `VM owner conflict for ${record.vmId}`)
    }
    owners.set(record.vmId, record.userId)
    fresh.push({ record, payload })
  }
  for (const { record, payload } of fresh) {
    const [at, until] = record.kind === "lifecycle" ? [record.observedAt, record.observedAt] : [record.start, record.end]
    sql.exec(
      `INSERT INTO meter_records (host_id, event_id, vm_id, user_id, kind, at, until, payload, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.hostId,
      record.eventId,
      record.vmId,
      record.userId,
      record.kind,
      at,
      until,
      payload,
      receivedAt,
    )
  }
  return { ok: true, value: { accepted: fresh.length, duplicates } }
}

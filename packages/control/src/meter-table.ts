/**
 * Nest hosts and the usage records they post, in the Hub's SQLite database. Ingestion is all or nothing per batch:
 * records are checked against what is stored and against each other before any is written.
 */
import type { MeterHost, MeterIngestResult, MeterRecord } from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"

/** Creates `meter_hosts` and `meter_records` when missing. */
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
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (host_id, event_id)
  )`)
  sql.exec(`CREATE INDEX IF NOT EXISTS meter_records_vm ON meter_records (vm_id)`)
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

/** Every stored record. Payloads were validated and canonicalized when stored. */
export const storedMeterRecords = (sql: FleetSql): MeterRecord[] =>
  sql
    .exec<{ payload: string }>(`SELECT payload FROM meter_records ORDER BY host_id, event_id`)
    .toArray()
    .map((row) => JSON.parse(row.payload) as MeterRecord)

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
    sql.exec(
      `INSERT INTO meter_records (host_id, event_id, vm_id, user_id, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      record.hostId,
      record.eventId,
      record.vmId,
      record.userId,
      payload,
      receivedAt,
    )
  }
  return { ok: true, value: { accepted: fresh.length, duplicates } }
}

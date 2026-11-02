import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import type { LifecycleRecord, MeterRecord, UsageRecord } from "@cloudagents/protocol"
import {
  ensureMeterTables,
  insertMeterHost,
  meterHostSecret,
  meterRecordsInWindow,
  purgeExpiredMeterRecords,
  storeMeterRecords,
} from "./meter-table"
import type { FleetSql } from "./fleet-table"

let db: Database
let sql: FleetSql

const RECEIVED = "2026-01-01T00:10:00.000Z"

const lifecycle = (eventId: string, vmId: string, observedAt: string, state: LifecycleRecord["state"]): MeterRecord => ({
  schemaVersion: 1,
  kind: "lifecycle",
  eventId,
  hostId: "host-a",
  vmId,
  userId: "alice",
  observedAt,
  state,
})

/** Every stored record; the window covers all the timestamps these tests use. */
const storedMeterRecords = (sql: FleetSql) =>
  meterRecordsInWindow(sql, "2025-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")

const usage = (eventId: string, overrides: Partial<UsageRecord> = {}): MeterRecord => ({
  schemaVersion: 1,
  kind: "usage",
  eventId,
  hostId: "host-a",
  vmId: "vm-1",
  userId: "alice",
  observedAt: "2026-01-01T00:01:00.000Z",
  start: "2026-01-01T00:00:00.000Z",
  end: "2026-01-01T00:01:00.000Z",
  measurements: { cpuCoreSeconds: 30 },
  ...overrides,
})

beforeEach(() => {
  db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  ensureMeterTables(sql)
})

describe("meter ingestion", () => {
  test("stores new records and counts none as duplicates", () => {
    const outcome = storeMeterRecords(sql, "host-a", [usage("e1"), usage("e2")], RECEIVED)
    expect(outcome).toEqual({ ok: true, value: { accepted: 2, duplicates: 0 } })
    expect(storedMeterRecords(sql)).toHaveLength(2)
  })

  test("a retried identical record is a duplicate, not a second copy", () => {
    storeMeterRecords(sql, "host-a", [usage("e1")], RECEIVED)
    const retry = storeMeterRecords(sql, "host-a", [usage("e1"), usage("e2")], RECEIVED)
    expect(retry).toEqual({ ok: true, value: { accepted: 1, duplicates: 1 } })
    expect(storedMeterRecords(sql).map((r) => r.eventId)).toEqual(["e1", "e2"])
  })

  test("the same eventId twice in one batch is a duplicate when identical", () => {
    const outcome = storeMeterRecords(sql, "host-a", [usage("e1"), usage("e1")], RECEIVED)
    expect(outcome).toEqual({ ok: true, value: { accepted: 1, duplicates: 1 } })
  })

  test("an eventId reused with different content refuses the whole batch", () => {
    storeMeterRecords(sql, "host-a", [usage("e1")], RECEIVED)
    const outcome = storeMeterRecords(
      sql,
      "host-a",
      [usage("e2"), usage("e1", { measurements: { cpuCoreSeconds: 9 } })],
      RECEIVED,
    )
    expect(outcome).toMatchObject({ ok: false, status: 409 })
    expect(storedMeterRecords(sql).map((r) => r.eventId)).toEqual(["e1"])
  })

  test("a record naming another host refuses the whole batch", () => {
    const outcome = storeMeterRecords(sql, "host-a", [usage("e1"), usage("e2", { hostId: "host-b" })], RECEIVED)
    expect(outcome).toMatchObject({ ok: false, status: 403 })
    expect(storedMeterRecords(sql)).toHaveLength(0)
  })

  test("a VM with a second owner refuses the batch", () => {
    storeMeterRecords(sql, "host-a", [usage("e1")], RECEIVED)
    const outcome = storeMeterRecords(sql, "host-a", [usage("e2", { userId: "bob" })], RECEIVED)
    expect(outcome).toMatchObject({ ok: false, status: 409 })
    expect(storedMeterRecords(sql)).toHaveLength(1)
  })

  test("overlapping usage is stored; reconciliation reports it", () => {
    storeMeterRecords(sql, "host-a", [usage("e1")], RECEIVED)
    const outcome = storeMeterRecords(sql, "host-a", [usage("e2", { start: "2026-01-01T00:00:30.000Z" })], RECEIVED)
    expect(outcome).toEqual({ ok: true, value: { accepted: 1, duplicates: 0 } })
  })
})

describe("meter hosts", () => {
  test("a host's secret is stored and readable by id", () => {
    insertMeterHost(sql, { id: "host-a", name: "nest-a", secret: "s3cret", createdAt: RECEIVED })
    expect(meterHostSecret(sql, "host-a")).toBe("s3cret")
    expect(meterHostSecret(sql, "missing")).toBeUndefined()
  })
})

describe("meter retention", () => {
  test("purging keeps each VM's latest lifecycle before the cutoff and drops usage that ended before it", () => {
    storeMeterRecords(
      sql,
      "host-a",
      [
        lifecycle("l-vm1-start", "vm-1", "2026-01-01T00:00:00.000Z", "running"),
        lifecycle("l-vm1-park", "vm-1", "2026-01-10T00:00:00.000Z", "parked"),
        lifecycle("l-vm2", "vm-2", "2026-01-05T00:00:00.000Z", "running"),
        usage("u-old", { start: "2026-01-02T00:00:00.000Z", end: "2026-01-02T00:01:00.000Z" }),
        usage("u-new", { start: "2026-05-01T00:00:00.000Z", end: "2026-05-01T00:01:00.000Z" }),
      ],
      RECEIVED,
    )
    purgeExpiredMeterRecords(sql, "2026-06-01T00:00:00.000Z")
    expect(storedMeterRecords(sql).map((r) => r.eventId).sort()).toEqual(["l-vm1-park", "l-vm2", "u-new"])
  })
})

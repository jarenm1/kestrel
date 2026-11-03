import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { appendLifecycleEvent, buildLifecycleRecord, validateLifecycleRecord } from "./lifecycle"
import { eventsPath } from "./state-store"
import type { LifecycleRecord } from "@cloudagents/protocol"
import { makeTempDir, type TempDir } from "./test-support"

let tmp: TempDir

beforeEach(() => {
  tmp = makeTempDir("events")
})

afterEach(() => tmp.dispose())

const valid = (): Record<string, unknown> => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  hostId: randomUUID(),
  vmId: randomUUID(),
  userId: "alice",
  observedAt: "2026-11-02T06:00:00.000Z",
  kind: "lifecycle",
  state: "running",
})

describe("lifecycle record validation", () => {
  test("accepts the v1 shape", () => {
    const value = valid()
    expect(validateLifecycleRecord(value)).toEqual(value as unknown as LifecycleRecord)
  })

  test("rejects unknown keys", () => {
    expect(() => validateLifecycleRecord({ ...valid(), usage: { cpuSeconds: 1 } })).toThrow()
  })

  test("rejects a timestamp without milliseconds", () => {
    expect(() => validateLifecycleRecord({ ...valid(), observedAt: "2026-11-02T06:00:00Z" })).toThrow()
  })

  test("rejects a timestamp that is not ISO 8601 UTC", () => {
    expect(() => validateLifecycleRecord({ ...valid(), observedAt: "2026-11-02 06:00:00.000Z" })).toThrow()
  })

  test("rejects a state outside running | parked | deleted", () => {
    expect(() => validateLifecycleRecord({ ...valid(), state: "stopped" })).toThrow()
  })

  test("rejects a kind other than lifecycle", () => {
    expect(() => validateLifecycleRecord({ ...valid(), kind: "usage" })).toThrow()
  })

  test("rejects an empty userId", () => {
    expect(() => validateLifecycleRecord({ ...valid(), userId: "" })).toThrow()
  })

  test("buildLifecycleRecord stamps a millisecond UTC timestamp", () => {
    const record = buildLifecycleRecord({ hostId: randomUUID(), vmId: randomUUID(), userId: "alice", state: "parked" })
    expect(record.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(record.kind).toBe("lifecycle")
    expect(record.schemaVersion).toBe(1)
  })
})

describe("events.jsonl", () => {
  test("appends one validated JSON line per record", () => {
    const record = buildLifecycleRecord({ hostId: randomUUID(), vmId: randomUUID(), userId: "alice", state: "running" })
    appendLifecycleEvent(tmp.path, record)
    appendLifecycleEvent(tmp.path, { ...record, eventId: randomUUID(), state: "parked" })
    const lines = readFileSync(eventsPath(tmp.path), "utf8").trim().split("\n")
    expect(lines.map((line) => JSON.parse(line).state)).toEqual(["running", "parked"])
  })

  test("refuses an invalid record and writes nothing", () => {
    const invalid = { ...valid(), observedAt: "bad" } as unknown as LifecycleRecord
    expect(() => appendLifecycleEvent(tmp.path, invalid)).toThrow()
    expect(existsSync(eventsPath(tmp.path))).toBe(false)
  })
})

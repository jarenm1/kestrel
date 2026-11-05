import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLeaseUntil, writeLeaseUntil } from "./lease"

const dir = mkdtempSync(join(tmpdir(), "lease-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("lease file", () => {
  test("round-trips validUntil", () => {
    const path = join(dir, "round-trip.json")
    writeLeaseUntil(path, 1_700_000_000_000)
    expect(readLeaseUntil(path)).toBe(1_700_000_000_000)
  })

  test("a missing, unreadable or malformed lease reads as expired (null)", () => {
    expect(readLeaseUntil(join(dir, "missing.json"))).toBeNull()
    const malformed = join(dir, "malformed.json")
    writeFileSync(malformed, '{"validUntil":"soon"}')
    expect(readLeaseUntil(malformed)).toBeNull()
    const notJson = join(dir, "not-json.json")
    writeFileSync(notJson, "{")
    expect(readLeaseUntil(notJson)).toBeNull()
  })
})

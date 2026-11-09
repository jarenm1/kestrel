import { expect, test } from "bun:test"
import type { PendingPairing } from "@cloudagents/protocol"
import { ApiError } from "@/api/errors"
import { PAIRING_POLL_MS, pairingApproved, pairingConflict, pairingPhase, pairingPollMs } from "./pairing"

const EXPIRES = "2026-11-01T00:10:00.000Z"
const pending: PendingPairing = {
  code: "ABCD-EFGH",
  name: "Desk",
  url: "https://box.example.com",
  expiresAt: EXPIRES,
}

test("a pending code becomes approved without waiting for its expiry", () => {
  expect(pairingPhase(pending, false, Date.parse(EXPIRES) - 1)?._tag).toBe("pending")
  expect(pairingPhase(pending, true, Date.parse(EXPIRES) - 1)?._tag).toBe("approved")
  expect(pairingPhase(pending, true, Date.parse(EXPIRES) + 1)?._tag).toBe("approved")
})

test("approval belongs to its code, and a 409 is the terminal approved phase", () => {
  expect(pairingApproved("ABCD-EFGH", "ABCD-EFGH")).toBe(true)
  expect(pairingApproved("ABCD-EFGH", "ZZZZ-ZZZZ")).toBe(false)
  expect(pairingApproved(null, "ABCD-EFGH")).toBe(false)
  expect(pairingPhase(pending, false, Date.parse(EXPIRES) - 1, false, true)?._tag).toBe("approved")
})

test("only a 409 for the submitted code is the terminal approve conflict", () => {
  const conflict = new ApiError(409, "pairing code already approved")
  expect(pairingConflict(conflict, "ABCD-EFGH", "ABCD-EFGH")).toBe(true)
  // The page's code changed while the request was in flight: the answer no longer describes what is on screen.
  expect(pairingConflict(conflict, "ZZZZ-ZZZZ", "ABCD-EFGH")).toBe(false)
  // The box-limit 409 is a validation error, not evidence the code was approved.
  expect(pairingConflict(new ApiError(409, "boxes per user limit reached"), "ABCD-EFGH", "ABCD-EFGH")).toBe(false)
  expect(pairingConflict(new ApiError(404, "no such pairing"), "ABCD-EFGH", "ABCD-EFGH")).toBe(false)
})

test("a pending code is expired at expiresAt, so the form cannot stay editable", () => {
  expect(pairingPhase(pending, false, Date.parse(EXPIRES) - 1)?._tag).toBe("pending")
  expect(pairingPhase(pending, false, Date.parse(EXPIRES))?._tag).toBe("expired")
  expect(pairingPhase(pending, false, Date.parse(EXPIRES) + 1)?._tag).toBe("expired")
  expect(pairingPhase(pending, false, Date.parse(EXPIRES), true)?._tag).toBe("expired")
})

test("polling continues for a pending or unresolved code and stops at a terminal phase", () => {
  const before = Date.parse(EXPIRES) - 1
  expect(pairingPollMs(pairingPhase(pending, false, before), undefined)).toBe(PAIRING_POLL_MS)
  // A transient failure with no data yet keeps polling, so the page recovers without a reload.
  expect(pairingPollMs(undefined, new TypeError("network"))).toBe(PAIRING_POLL_MS)
  // A permanent 404 does not, and neither does a 409 from an already-approved code.
  expect(pairingPollMs(undefined, new ApiError(404, "no such pairing"))).toBe(false)
  expect(pairingPollMs(undefined, new ApiError(409, "pairing code already approved"))).toBe(false)
  expect(pairingPollMs(pairingPhase(pending, true, before), undefined)).toBe(false)
  expect(pairingPollMs(pairingPhase(pending, false, Date.parse(EXPIRES)), undefined)).toBe(false)
})

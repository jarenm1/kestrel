import { expect, test } from "bun:test"
import { ApiError, isUnreachableError, responseError } from "../api/errors"
import { threadErrors } from "./threadErrors"

const cached = (error: unknown = null) => ({ data: [], error })
const cold = (error: unknown) => ({ data: undefined, error })

for (const status of [502, 503, 504]) {
  test(`application ${status} remains visible; only explicit relay failures are suppressed`, () => {
    const application = responseError(status, JSON.stringify({ _tag: "BadGateway", message: "upstream provider unavailable" }), "")
    const relay = responseError(status, JSON.stringify({ _tag: "BoxOffline", message: "agent box unreachable" }), "")
    expect(isUnreachableError(application)).toBe(false)
    expect(isUnreachableError(relay)).toBe(true)
    expect(threadErrors([cached(application)], false, false).error).toBe("upstream provider unavailable")
    expect(threadErrors([cached(relay)], true, false)).toEqual({ error: null, loadError: null })
    expect(isUnreachableError(new ApiError(status, "untagged failure"))).toBe(false)
  })
}

test("a suppressed task failure cannot mask a later messages or runs error", () => {
  const transport = new ApiError(0, "network unavailable")
  const application = new ApiError(503, "run storage unavailable", "StorageError")
  for (const queries of [[cached(transport), cached(application), cached()], [cached(transport), cached(), cached(application)]]) {
    expect(threadErrors(queries, true, true)).toEqual({ loadError: null, error: "run storage unavailable" })
  }
})

test("a missing initial snapshot has an explicit unavailable-content state", () => {
  const offline = new ApiError(503, "agent box not connected", "BoxOffline")
  for (const queries of [[cold(offline), cold(offline), cold(offline)], [cached(), cold(offline), cached()]]) {
    const state = threadErrors(queries, true, false)
    expect(state.loadError).toBe("Could not load this conversation. agent box not connected")
    expect(state.error).toBeNull()
  }
})

test("an actionable query failure wins even when another initial snapshot is unreachable", () => {
  const state = threadErrors([cold(new ApiError(0, "network unavailable")), cold(new ApiError(403, "access denied"))], true, false)
  expect(state).toEqual({ loadError: "Could not load this conversation. access denied", error: null })
})

test("cached idle outages stay quiet but interrupted turns warn", () => {
  const queries = [cached(new ApiError(0, "network unavailable")), cached(), cached()]
  expect(threadErrors(queries, true, false)).toEqual({ loadError: null, error: null })
  expect(threadErrors(queries, true, true)).toEqual({ loadError: null, error: "The connection to this turn's box was lost. Reconnecting…" })
  expect(threadErrors(queries, false, true)).toEqual({ loadError: null, error: null })
})

test("invalid/plain gateway responses are errors, not proof the box is offline", () => {
  const error = responseError(502, "gateway refused the request", "Bad Gateway")
  expect(error.message).toBe("gateway refused the request")
  expect(isUnreachableError(error)).toBe(false)
})

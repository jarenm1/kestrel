import { describe, expect, test } from "bun:test"
import { fragmentWs, hostWs, isAuthClose } from "./embed"

describe("hostWs", () => {
  test("accepts the object and its JSON string", () => {
    const msg = { type: "kestrel-desktop", ws: "wss://app.example/api/tasks/t1/desktop/stream" }
    expect(hostWs(msg)).toBe(msg.ws)
    expect(hostWs(JSON.stringify(msg))).toBe(msg.ws)
  })

  test("ignores other traffic", () => {
    expect(hostWs({ type: "other", ws: "wss://x" })).toBeNull()
    expect(hostWs({ type: "kestrel-desktop" })).toBeNull()
    expect(hostWs("not json")).toBeNull()
    expect(hostWs(42)).toBeNull()
    expect(hostWs(null)).toBeNull()
  })
})

describe("fragmentWs", () => {
  test("decodes the encoded URL once", () => {
    const url = "wss://app.example/api/tasks/t1/desktop/stream?token=a+b&x=1"
    const hash = `#ws=${encodeURIComponent(url)}&task=t1`
    expect(fragmentWs(hash)).toBe(url)
  })

  test("is null without a ws parameter", () => {
    expect(fragmentWs("")).toBeNull()
    expect(fragmentWs("#task=t1")).toBeNull()
  })
})

describe("isAuthClose", () => {
  test("unauthorized closes and sockets that never opened", () => {
    expect(isAuthClose({ code: 4401, opened: true })).toBe(true)
    expect(isAuthClose({ code: 401, opened: true })).toBe(true)
    expect(isAuthClose({ code: null, opened: false })).toBe(true)
  })

  test("a stream that dropped after it was live is not an auth failure", () => {
    expect(isAuthClose({ code: 1006, opened: true })).toBe(false)
    expect(isAuthClose({ code: 1001, opened: true })).toBe(false)
  })
})

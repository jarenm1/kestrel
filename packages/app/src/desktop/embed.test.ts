import { describe, expect, test } from "bun:test"
import { fragmentWs, hostWs, isAuthClose, isUnreachable, mayConnect } from "./embed"

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
  test("unauthorized closes", () => {
    expect(isAuthClose({ code: 4401, opened: true })).toBe(true)
    expect(isAuthClose({ code: 401, opened: true })).toBe(true)
  })

  test("a socket that never opened may just be a network or box that is down", () => {
    expect(isAuthClose({ code: null, opened: false })).toBe(false)
    expect(isAuthClose({ code: 1006, opened: false })).toBe(false)
  })

  test("a stream that dropped after it was live is not an auth failure", () => {
    expect(isAuthClose({ code: 1006, opened: true })).toBe(false)
    expect(isAuthClose({ code: 1001, opened: true })).toBe(false)
  })
})

describe("isUnreachable", () => {
  test("a handshake that failed, unless it said why", () => {
    expect(isUnreachable({ code: null, opened: false })).toBe(true)
    expect(isUnreachable({ code: 1006, opened: false })).toBe(true)
    expect(isUnreachable({ code: 4401, opened: false })).toBe(false)
    expect(isUnreachable({ code: 1006, opened: true })).toBe(false)
  })
})

describe("mayConnect", () => {
  const app = "https://app.example"
  const own = "wss://app.example/api/tasks/t1/desktop/stream"
  const box = "wss://box.example/api/tasks/t1/desktop/stream?access_token=a"
  const page = { origin: app, bridged: false, framed: "no" } as const

  test("a page opened directly connects only to its own host", () => {
    expect(mayConnect(own, page)).toBe(true)
    expect(mayConnect(box, page)).toBe(false)
  })

  test("the native WebView and the app's own frame can name a user's box", () => {
    expect(mayConnect(box, { ...page, bridged: true })).toBe(true)
    expect(mayConnect(box, { ...page, framed: "same-origin" })).toBe(true)
  })

  test("another site's frame connects to nothing, its own host included", () => {
    expect(mayConnect(own, { ...page, framed: "cross-origin" })).toBe(false)
    expect(mayConnect(box, { ...page, framed: "cross-origin" })).toBe(false)
  })

  test("only a desktop stream URL qualifies", () => {
    const bridged = { ...page, bridged: true }
    expect(mayConnect("wss://app.example/api/events", bridged)).toBe(false)
    expect(mayConnect("https://app.example/api/tasks/t1/desktop/stream", bridged)).toBe(false)
    expect(mayConnect("not a url", bridged)).toBe(false)
  })
})

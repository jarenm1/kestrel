import { describe, expect, test } from "bun:test"
import { boxUrlKind, checkReach, parseBoxUrl, reachText } from "./boxReach"

describe("parseBoxUrl", () => {
  test("accepts HTTPS origins and http on loopback, dropping a trailing slash", () => {
    expect(parseBoxUrl(" https://box.example.com/ ")).toBe("https://box.example.com")
    expect(parseBoxUrl("http://localhost:8787")).toBe("http://localhost:8787")
    expect(parseBoxUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
  })

  test("rejects what the server rejects, so no request is made for it", () => {
    expect(parseBoxUrl("")).toBeNull()
    expect(parseBoxUrl("box.example.com")).toBeNull()
    expect(parseBoxUrl("http://192.168.1.20:8787")).toBeNull()
    expect(parseBoxUrl("https://box.example.com/api")).toBeNull()
  })
})

describe("boxUrlKind", () => {
  test("loopback, Tailscale names and other HTTPS hosts", () => {
    expect(boxUrlKind("http://localhost:8787")).toBe("local")
    expect(boxUrlKind("http://[::1]:8787")).toBe("local")
    expect(boxUrlKind("https://desk.tail1234.ts.net")).toBe("tailnet")
    expect(boxUrlKind("https://box.example.com")).toBe("https")
  })
})

describe("checkReach", () => {
  test("reachable only when the box answers online", async () => {
    expect(await checkReach("https://a", async () => ({ online: true }))).toBe(true)
    expect(await checkReach("https://a", async () => ({ online: false }))).toBe(false)
    expect(await checkReach("https://a", () => Promise.reject(new Error("network")))).toBe(false)
  })

  test("a check that never settles counts as unreachable after the timeout", async () => {
    expect(await checkReach("https://a", () => new Promise(() => {}), 10)).toBe(false)
  })
})

describe("reachText", () => {
  test("speaks only for this device and keeps the desktop separate", () => {
    for (const kind of ["local", "tailnet", "https"] as const) {
      expect(reachText(kind, true)).toContain("This device reached")
      expect(reachText(kind, true)).toContain("WebRTC")
      expect(reachText(kind, false)).toContain("This device could not reach")
      expect(reachText(kind, false)).not.toContain("offline")
    }
    expect(reachText("local", false)).toContain("machine this browser runs on")
    expect(reachText("tailnet", false)).toContain("same tailnet")
    expect(reachText("tailnet", false)).toContain("local network access")
  })
})

import { describe, expect, test } from "bun:test"
import type { Exec } from "./system"
import {
  detectTailscale,
  enableTailscaleServe,
  networkChecks,
  proxiesLocalPort,
  resolveBoxUrl,
  suggestedUrl,
} from "./network"
import type { ExecDeps, Tailscale } from "./network"

const PORT = 18787

const ok = (stdout: string): Exec => ({ status: 0, stdout, stderr: "" })
const fail = (stderr = "failed"): Exec => ({ status: 1, stdout: "", stderr })
const timedOut: Exec = { status: null, stdout: "", stderr: "" }

const statusJson = (backendState: string, dnsName?: string): string =>
  JSON.stringify({ BackendState: backendState, Self: dnsName === undefined ? {} : { DNSName: dnsName } })

const serveJson = (proxy: string | null, tcpPort = "443"): string =>
  proxy === null
    ? "{}"
    : JSON.stringify({ TCP: { [tcpPort]: { Handlers: { "/": { Proxy: proxy } } } } })

const deps = (handlers: { status?: Exec; serve?: Exec }, tailscalePath: string | null = "/usr/bin/tailscale"): ExecDeps => ({
  onPath: (name) => (name === "tailscale" ? tailscalePath : null),
  run: (_cmd, args) =>
    args[0] === "status" ? (handlers.status ?? fail("unstubbed")) : (handlers.serve ?? fail("unstubbed")),
})

const running = (serve: Exec): ExecDeps =>
  deps({ status: ok(statusJson("Running", "box.tail-abc.ts.net.")), serve })

describe("detectTailscale", () => {
  test("no tailscale CLI on PATH", () => {
    const ts = detectTailscale(deps({}, null))
    expect(ts).toEqual({ installed: false, running: false, dnsName: null, serveTargets: [] })
  })

  test("installed but logged out", () => {
    const ts = detectTailscale(deps({ status: ok(statusJson("NeedsLogin")) }))
    expect(ts.installed).toBe(true)
    expect(ts.running).toBe(false)
    expect(ts.dnsName).toBeNull()
    expect(ts.serveTargets).toEqual([])
  })

  test("status command fails (tailscaled stopped)", () => {
    const ts = detectTailscale(deps({ status: fail("Tailscale is stopped") }))
    expect(ts.installed).toBe(true)
    expect(ts.running).toBe(false)
  })

  test("command times out", () => {
    const ts = detectTailscale(deps({ status: timedOut }))
    expect(ts.installed).toBe(true)
    expect(ts.running).toBe(false)
    expect(ts.dnsName).toBeNull()
  })

  test("invalid JSON output", () => {
    const ts = detectTailscale(deps({ status: ok("not json at all") }))
    expect(ts.installed).toBe(true)
    expect(ts.running).toBe(false)
    expect(ts.dnsName).toBeNull()
  })

  test("running: strips the trailing dot from DNSName", () => {
    const ts = detectTailscale(running(ok(serveJson(null))))
    expect(ts.running).toBe(true)
    expect(ts.dnsName).toBe("box.tail-abc.ts.net")
  })

  test("running: collects 443 serve targets", () => {
    const ts = detectTailscale(running(ok(serveJson(`http://127.0.0.1:${PORT}`))))
    expect(ts.serveTargets).toEqual([`http://127.0.0.1:${PORT}`])
  })

  test("running: serve command failure yields no targets", () => {
    const ts = detectTailscale(running(fail("serve failed")))
    expect(ts.dnsName).toBe("box.tail-abc.ts.net")
    expect(ts.serveTargets).toEqual([])
  })
})

describe("suggestedUrl", () => {
  const ts = (serveTargets: string[], dnsName: string | null = "box.tail-abc.ts.net"): Tailscale => ({
    installed: true,
    running: dnsName !== null,
    dnsName,
    serveTargets,
  })

  test("serve proxies 443 to the box port", () => {
    expect(suggestedUrl(ts([`http://127.0.0.1:${PORT}`]), PORT)).toBe("https://box.tail-abc.ts.net")
  })

  test("accepts localhost and ::1 targets and trailing paths", () => {
    expect(suggestedUrl(ts([`http://localhost:${PORT}/`]), PORT)).toBe("https://box.tail-abc.ts.net")
    expect(suggestedUrl(ts([`http://[::1]:${PORT}`]), PORT)).toBe("https://box.tail-abc.ts.net")
  })

  test("DNSName alone is not enough", () => {
    expect(suggestedUrl(ts([]), PORT)).toBeNull()
  })

  test("serve proxying a different port is not a suggestion", () => {
    expect(suggestedUrl(ts(["http://127.0.0.1:3000"]), PORT)).toBeNull()
    expect(suggestedUrl(ts(["http://192.168.1.5:8787"]), PORT)).toBeNull()
  })

  test("malformed serve targets are ignored", () => {
    expect(suggestedUrl(ts(["not a url", "also:not:a:url"]), PORT)).toBeNull()
  })

  test("no suggestion when logged out", () => {
    expect(suggestedUrl(ts([], null), PORT)).toBeNull()
  })
})

describe("proxiesLocalPort", () => {
  test("matches only loopback hosts on the given port", () => {
    expect(proxiesLocalPort(`http://127.0.0.1:${PORT}`, PORT)).toBe(true)
    expect(proxiesLocalPort(`http://127.0.0.1:${PORT + 1}`, PORT)).toBe(false)
    expect(proxiesLocalPort(`http://example.com:${PORT}`, PORT)).toBe(false)
    expect(proxiesLocalPort(`https+insecure://localhost:${PORT}`, PORT)).toBe(true)
    expect(proxiesLocalPort("garbage", PORT)).toBe(false)
  })
})

describe("resolveBoxUrl", () => {
  test("an explicit --url always wins, even over a valid Serve config", () => {
    const resolved = resolveBoxUrl("https://box.example.com", PORT, running(ok(serveJson(`http://127.0.0.1:${PORT}`))))
    expect(resolved).toEqual({ url: "https://box.example.com", source: "explicit" })
  })

  test("a valid Serve config is suggested", () => {
    const resolved = resolveBoxUrl(undefined, PORT, running(ok(serveJson(`http://127.0.0.1:${PORT}`))))
    expect(resolved).toEqual({ url: "https://box.tail-abc.ts.net", source: "tailscale-serve" })
  })

  test("falls back to localhost", () => {
    expect(resolveBoxUrl(undefined, PORT, deps({}, null))).toEqual({
      url: `http://localhost:${PORT}`,
      source: "localhost",
    })
    expect(resolveBoxUrl(undefined, PORT, running(ok(serveJson("http://127.0.0.1:3000"))))).toEqual({
      url: `http://localhost:${PORT}`,
      source: "localhost",
    })
  })
})

describe("networkChecks", () => {
  test("reports a working Serve setup", () => {
    const ts: Tailscale = {
      installed: true,
      running: true,
      dnsName: "box.tail-abc.ts.net",
      serveTargets: [`http://127.0.0.1:${PORT}`],
    }
    const checks = networkChecks(PORT, ts)
    expect(checks.every((check) => check.ok)).toBe(true)
    expect(checks.every((check) => !check.required)).toBe(true)
  })

  test("a wrong-port Serve config is visible, not silently ok", () => {
    const ts: Tailscale = {
      installed: true,
      running: true,
      dnsName: "box.tail-abc.ts.net",
      serveTargets: ["http://127.0.0.1:3000"],
    }
    const serve = networkChecks(PORT, ts).find((check) => check.name === "tailscale serve -> box")!
    expect(serve.ok).toBe(false)
    expect(serve.detail).toContain("not this box's port")
  })
})

describe("enableTailscaleServe", () => {
  const base: Tailscale = { installed: true, running: true, dnsName: "box.tail-abc.ts.net", serveTargets: [] }

  test("refuses without tailscale installed", () => {
    expect(() => enableTailscaleServe(base, PORT, deps({}, null))).toThrow("not installed")
  })

  test("refuses when logged out instead of running tailscale up", () => {
    expect(() => enableTailscaleServe({ ...base, running: false, dnsName: null }, PORT, deps({}))).toThrow("not logged in")
  })

  test("refuses to overwrite an existing 443 Serve config", () => {
    const ts: Tailscale = { ...base, serveTargets: ["http://127.0.0.1:3000"] }
    expect(() => enableTailscaleServe(ts, PORT, running(ok(serveJson(null))))).toThrow("not overwriting")
  })

  test("is a no-op when it already publishes the box port", () => {
    let calls = 0
    const ts: Tailscale = { ...base, serveTargets: [`http://127.0.0.1:${PORT}`] }
    const counting: ExecDeps = {
      onPath: () => "/usr/bin/tailscale",
      run: () => {
        calls += 1
        return ok("")
      },
    }
    enableTailscaleServe(ts, PORT, counting)
    expect(calls).toBe(0)
  })

  test("enables serve and re-detects", () => {
    const calls: string[][] = []
    const d: ExecDeps = {
      onPath: () => "/usr/bin/tailscale",
      run: (_cmd, args) => {
        calls.push([...args])
        if (args[0] === "status") return ok(statusJson("Running", "box.tail-abc.ts.net."))
        if (args[0] === "serve" && args[1] === "status") return ok(serveJson(`http://127.0.0.1:${PORT}`))
        return ok("")
      },
    }
    const after = enableTailscaleServe(base, PORT, d)
    expect(calls).toContainEqual(["serve", "--bg", "--https=443", `http://127.0.0.1:${PORT}`])
    expect(suggestedUrl(after, PORT)).toBe("https://box.tail-abc.ts.net")
  })

  test("surfaces a serve failure with its stderr", () => {
    const d: ExecDeps = {
      onPath: () => "/usr/bin/tailscale",
      run: (_cmd, args) => (args[0] === "serve" && args[1] === "status" ? ok("{}") : args[0] === "status" ? ok(statusJson("Running", "box.tail-abc.ts.net.")) : fail("access denied")),
    }
    expect(() => enableTailscaleServe(base, PORT, d)).toThrow("access denied")
  })
})

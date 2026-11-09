import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { callbackPath, loginUrl, parseCallback, safeLocalPath, type CallbackPath } from "./auth"
import { acceptCallback, type HandoffPorts } from "./handoff"
import { createSerialQueue } from "./queue"
import { startDesktopServer, type DesktopServer } from "./server"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const fakeControl = async (): Promise<{
  url: string
  seen: Array<{ url: string | undefined; cookie: string | undefined }>
  wsCookie: () => string | undefined
}> => {
  const seen: Array<{ url: string | undefined; cookie: string | undefined }> = []
  const wss = new WebSocketServer({ noServer: true })
  let websocketCookie: string | undefined
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url === "/api/me") {
      res.setHeader("content-type", "application/json")
      res.end('{"login":"octocat"}')
      return
    }
    if (req.url === "/auth/logout") {
      res.statusCode = 204
      res.end()
      return
    }
    res.end("control")
  })
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/events") {
      socket.destroy()
      return
    }
    websocketCookie = req.headers.cookie
    wss.handleUpgrade(req, socket, head, (client) => client.send("hello"))
  })
  const ready = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", ready.resolve)
  await ready.promise
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fake control did not bind")
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        wss.close()
        server.close(() => done())
      }),
  )
  return { url: `http://127.0.0.1:${address.port}`, seen, wsCookie: () => websocketCookie }
}

const fakeApp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-desktop-"))
  await mkdir(join(dir, "assets"), { recursive: true })
  await writeFile(join(dir, "index.html"), "<h1>kestrel</h1>")
  await writeFile(join(dir, "assets", "app.js"), "console.log('kestrel')")
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const start = async (
  callback: CallbackPath = "/auth/desktop-callback",
  options: { clearSession?: () => Promise<void> } = {},
): Promise<{
  desktop: DesktopServer
  controlUrl: string
  cleared: () => boolean
  seen: Array<{ url: string | undefined; cookie: string | undefined }>
  wsCookie: () => string | undefined
}> => {
  const control = await fakeControl()
  const appDist = await fakeApp()
  let cleared = false
  const desktop = await startDesktopServer({
    appDist,
    controlUrl: control.url,
    callbackPath: callback,
    getSession: async () => "session-id",
    clearSession:
      options.clearSession ??
      (async () => {
        cleared = true
      }),
  })
  cleanups.push(() => desktop.close())
  return { desktop, controlUrl: control.url, cleared: () => cleared, seen: control.seen, wsCookie: control.wsCookie }
}

describe("desktop auth helpers", () => {
  test("parses the desktop and mobile fallback callbacks", () => {
    expect(parseCallback("kestrel-desktop://auth-callback?session=abc")).toEqual({ session: "abc", state: null })
    expect(parseCallback("kestrel://auth-callback?session=abc")).toEqual({ session: "abc", state: null })
    expect(parseCallback("kestrel-desktop://auth-callback?session=abc&state=xyz")).toEqual({ session: "abc", state: "xyz" })
    expect(parseCallback("kestrel-desktop://other?session=abc")).toBeNull()
    expect(parseCallback("kestrel-desktop://auth-callback")).toBeNull()
    expect(parseCallback("not a url")).toBeNull()
  })

  test("builds the control-plane login URL and keeps returns local", () => {
    expect(loginUrl("https://app.example/")).toBe(
      "https://app.example/auth/github/login?return=%2Fauth%2Fdesktop-callback",
    )
    expect(loginUrl("https://app.example/", "/auth/mobile-callback")).toBe(
      "https://app.example/auth/github/login?return=%2Fauth%2Fmobile-callback",
    )
    expect(loginUrl("https://app.example/", "/auth/desktop-callback", "nonce123")).toBe(
      "https://app.example/auth/github/login?return=%2Fauth%2Fdesktop-callback&state=nonce123",
    )
    expect(safeLocalPath("/c/123?x=1")).toBe("/c/123?x=1")
    expect(safeLocalPath("//evil.example")).toBe("/")
    expect(safeLocalPath("https://evil.example")).toBe("/")
    expect(safeLocalPath(null)).toBe("/")
  })

  test("requires the desktop callback", async () => {
    expect(await callbackPath("https://app.example", async () => new Response(null, { status: 404 }))).toBe(
      "/auth/desktop-callback",
    )
    expect(
      await callbackPath("https://app.example", async () => {
        throw new Error("unreachable")
      }),
    ).toBe("/auth/desktop-callback")
  })
})

describe("desktop proxy", () => {
  test("bootstraps a local cookie and serves the SPA", async () => {
    const { desktop } = await start()
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const denied = await fetch(`${desktop.origin}/`, { redirect: "manual" })
    expect(denied.status).toBe(401)

    const boot = await fetch(`${desktop.origin}${desktop.bootstrapPath}`, { redirect: "manual" })
    expect(boot.status).toBe(302)
    expect(boot.headers.get("set-cookie")).toContain(`kestrel_desktop=${token}`)
    const cookie = `kestrel_desktop=${token}`

    const index = await fetch(`${desktop.origin}/`, { headers: { cookie } })
    expect(await index.text()).toContain("<h1>kestrel</h1>")
    const asset = await fetch(`${desktop.origin}/assets/app.js`, { headers: { cookie } })
    expect(asset.headers.get("content-type")).toContain("text/javascript")
    const spa = await fetch(`${desktop.origin}/c/123`, { headers: { cookie, accept: "text/html" } })
    expect(await spa.text()).toContain("<h1>kestrel</h1>")
  })

  test("proxies control calls with the stored session and clears it on logout", async () => {
    const { desktop, controlUrl, cleared, seen } = await start()
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const cookie = `kestrel_desktop=${token}`
    expect(controlUrl.startsWith("http://127.0.0.1:")).toBe(true)
    const me = await fetch(`${desktop.origin}/api/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.text()).toBe('{"login":"octocat"}')
    expect(seen.at(-1)?.cookie).toBe("session=session-id")

    const logout = await fetch(`${desktop.origin}/auth/logout`, { method: "POST", headers: { cookie } })
    expect(logout.status).toBe(204)
    expect(cleared()).toBe(true)

    await fetch(`${desktop.origin}/api/me`, { headers: { cookie } })
    // The fake control still answers, but the proxy must no longer attach a session.
    expect(seen.at(-1)?.cookie).toBeUndefined()
  })

  test("proxies control websockets with the session cookie", async () => {
    const { desktop, wsCookie } = await start()
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const socket = new WebSocket(`${desktop.origin.replace("http", "ws")}/api/events`, {
      headers: { cookie: `kestrel_desktop=${token}` },
    })
    const message = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(String(data)))
      socket.once("error", reject)
    })
    expect(message).toBe("hello")
    expect(wsCookie()).toBe("session=session-id")
    socket.close()
  })

  test("redirects sign-in to the control plane and remembers the app return path", async () => {
    const { desktop, controlUrl } = await start()
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const response = await fetch(`${desktop.origin}/auth/github/login?return=%2Fc%2F9`, {
      redirect: "manual",
      headers: { cookie: `kestrel_desktop=${token}` },
    })
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location") ?? "http://invalid")
    expect(location.pathname).toBe("/auth/github/login")
    expect(location.searchParams.get("return")).toBe("/auth/desktop-callback")
    expect(location.searchParams.get("state") ?? "").not.toBe("")
    expect(desktop.takePendingReturn()).toBe("/c/9")
  })

  test("uses the mobile callback on a control plane without the desktop route", async () => {
    const { desktop, controlUrl } = await start("/auth/mobile-callback")
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const response = await fetch(`${desktop.origin}/auth/github/login`, {
      redirect: "manual",
      headers: { cookie: `kestrel_desktop=${token}` },
    })
    const location = new URL(response.headers.get("location") ?? "http://invalid")
    expect(location.pathname).toBe("/auth/github/login")
    expect(location.searchParams.get("return")).toBe("/auth/mobile-callback")
    expect(location.searchParams.get("state") ?? "").not.toBe("")
  })
})

describe("desktop sign-in handoff", () => {
  const callbackUrl = (session: string, state: string) =>
    `kestrel-desktop://auth-callback?session=${session}&state=${state}`

  const ports = (overrides: Partial<HandoffPorts> = {}): HandoffPorts => {
    let nonce: string | null = "expected"
    return {
      pendingNonce: () => nonce,
      claimPendingNonce: (value) => {
        if (nonce === null || nonce !== value) return false
        nonce = null
        return true
      },
      readSession: async () => null,
      storeSession: async () => undefined,
      clearSession: async () => undefined,
      ...overrides,
    }
  }

  test("a stray or forged callback cannot burn the pending nonce", async () => {
    let nonce: string | null = "expected"
    const stored: string[] = []
    const write = ports({
      pendingNonce: () => nonce,
      claimPendingNonce: (value) => {
        if (nonce === null || nonce !== value) return false
        nonce = null
        return true
      },
      storeSession: async (session) => {
        stored.push(session)
      },
    })
    expect(await acceptCallback(callbackUrl("evil", "forged"), write)).toEqual({ _tag: "ignored" })
    expect(nonce).toBe("expected")
    expect(stored).toEqual([])

    expect(await acceptCallback(callbackUrl("good", "expected"), write)).toEqual({
      _tag: "signed-in",
      session: "good",
    })
    expect(nonce).toBeNull()
    expect(stored).toEqual(["good"])

    // Single use: replaying the same callback cannot sign in again.
    expect(await acceptCallback(callbackUrl("good", "expected"), write)).toEqual({ _tag: "ignored" })
    expect(stored).toEqual(["good"])
  })

  test("the session is stored before the nonce is consumed", async () => {
    const order: string[] = []
    const result = await acceptCallback(
      callbackUrl("session-1", "expected"),
      ports({
        storeSession: async (session) => {
          order.push(`store:${session}`)
        },
        claimPendingNonce: (value) => {
          order.push(`claim:${value}`)
          return value === "expected"
        },
      }),
    )
    expect(result).toEqual({ _tag: "signed-in", session: "session-1" })
    expect(order).toEqual(["store:session-1", "claim:expected"])
  })

  test("a failed store leaves the nonce for the next delivery", async () => {
    let claimed = false
    await expect(
      acceptCallback(
        callbackUrl("session-1", "expected"),
        ports({
          storeSession: async () => {
            throw new Error("disk is read-only")
          },
          claimPendingNonce: () => {
            claimed = true
            return true
          },
        }),
      ),
    ).rejects.toThrow("disk is read-only")
    expect(claimed).toBe(false)
  })

  test("a newer sign-in during the store restores the previous session", async () => {
    const writes: string[] = []
    let nonce = "old"
    const result = await acceptCallback(callbackUrl("older-session", "old"), {
      pendingNonce: () => nonce,
      claimPendingNonce: () => false,
      readSession: async () => "previous-session",
      storeSession: async (session) => {
        writes.push(session)
        // The user started another sign-in while the file was being written.
        nonce = "new"
      },
      clearSession: async () => {
        writes.push("cleared")
      },
    })
    expect(result).toEqual({ _tag: "superseded" })
    expect(writes).toEqual(["older-session", "previous-session"])
    expect(nonce).toBe("new")
  })

  test("the desktop server's nonce is only consumed by the matching callback", async () => {
    const { desktop } = await start()
    const stored: string[] = []
    const write: HandoffPorts = {
      pendingNonce: () => desktop.pendingNonce(),
      claimPendingNonce: (nonce) => desktop.claimPendingNonce(nonce),
      readSession: async () => null,
      storeSession: async (session) => {
        stored.push(session)
      },
      clearSession: async () => {
        stored.length = 0
      },
    }
    desktop.setPendingNonce("real-nonce")
    expect(await acceptCallback(callbackUrl("evil", "wrong"), write)).toEqual({ _tag: "ignored" })
    expect(desktop.pendingNonce()).toBe("real-nonce")

    expect(await acceptCallback(callbackUrl("good", "real-nonce"), write)).toEqual({
      _tag: "signed-in",
      session: "good",
    })
    expect(desktop.pendingNonce()).toBeNull()
    expect(stored).toEqual(["good"])
  })
})

describe("desktop logout reconciliation", () => {
  test("keeps the in-memory session when the stored copy cannot be cleared", async () => {
    const refused = Promise.withResolvers<void>()
    const { desktop, seen } = await start(undefined, { clearSession: () => refused.promise })
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const cookie = `kestrel_desktop=${token}`

    const logout = await fetch(`${desktop.origin}/auth/logout`, { method: "POST", headers: { cookie } })
    expect(logout.status).toBe(204)
    refused.reject(new Error("disk is read-only"))
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The file still holds a session, so the proxy must not claim the user is signed out.
    await fetch(`${desktop.origin}/api/me`, { headers: { cookie } })
    expect(seen.at(-1)?.cookie).toBe("session=session-id")
  })

  test("a sign-in during a failed logout clear is not overwritten by the old session", async () => {
    const refused = Promise.withResolvers<void>()
    const { desktop, seen } = await start(undefined, { clearSession: () => refused.promise })
    const token = desktop.bootstrapPath.split("/").pop() ?? ""
    const cookie = `kestrel_desktop=${token}`

    const logout = await fetch(`${desktop.origin}/auth/logout`, { method: "POST", headers: { cookie } })
    expect(logout.status).toBe(204)

    // A sign-in callback lands while the clear is still pending, then the clear fails.
    desktop.setSession("session-b")
    refused.reject(new Error("disk is read-only"))
    await new Promise((resolve) => setTimeout(resolve, 10))

    await fetch(`${desktop.origin}/api/me`, { headers: { cookie } })
    expect(seen.at(-1)?.cookie).toBe("session=session-b")
  })
})

describe("desktop auth queue", () => {
  test("tasks run one at a time in submission order", async () => {
    const queue = createSerialQueue(() => undefined)
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    const first = queue(async () => {
      order.push("first:start")
      await gate.promise
      order.push("first:end")
    })
    const second = queue(async () => {
      order.push("second")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["first:start"])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  test("a failing task is reported and does not block the next one", async () => {
    const errors: unknown[] = []
    const queue = createSerialQueue((error) => {
      errors.push(error)
    })
    const order: string[] = []
    const first = queue(async () => {
      order.push("first")
      throw new Error("boom")
    })
    const second = queue(async () => {
      order.push("second")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["first", "second"])
    expect(errors).toHaveLength(1)
  })

  test("a sign-in callback queued behind a logout does not overlap it", async () => {
    const queue = createSerialQueue(() => undefined)
    const events: string[] = []
    const logoutDone = Promise.withResolvers<void>()
    const logout = queue(async () => {
      events.push("logout:start")
      await logoutDone.promise
      events.push("logout:end")
    })
    const callback = queue(async () => {
      events.push("callback")
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The callback waits: the logout's clear and the callback's store cannot interleave.
    expect(events).toEqual(["logout:start"])

    logoutDone.resolve()
    await Promise.all([logout, callback])
    expect(events).toEqual(["logout:start", "logout:end", "callback"])
  })
})

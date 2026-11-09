import { describe, expect, test } from "bun:test"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { Effect, Runtime } from "effect"
import { BOX_USER_HEADER, type BoxTokenClaims, type RelayCredentials, signBoxToken } from "@cloudagents/protocol"
import type { CredentialStoreShape } from "../credentials"
import type { WsServices } from "../http/streams"
import { Unauthorized, makeBoxAuth, type DirectSettings } from "./auth"
import { makeBoxActivityReporter } from "./box-activity"
import { makeDirectListener, OFFLINE_HEADER } from "./listener"

const token = "11111111-1111-4111-8111-111111111111"
const settings = { controlUrl: "http://control.invalid", boxId: "managed", boxSecret: "test-secret" }

const setup = () => {
  let now = Date.parse("2026-11-05T12:00:00.000Z")
  const activity = makeBoxActivityReporter(settings, { now: () => now })
  // HTTP routing does not run stream services or open an RTC channel.
  const runtime = Runtime.defaultRuntime as Runtime.Runtime<WsServices>
  const listener = makeDirectListener({
    auth: { authenticate: () => Effect.fail(new Unauthorized({ message: "no box token" })) },
    activity,
    core: { previewTokenFor: (candidate) => Effect.succeed(candidate === token ? { user: "alice", taskId: "task" } : null) },
    webHandler: async () => new Response("preview content"),
    runtime,
  })
  return { activity, listener, advance: (ms: number) => { now += ms } }
}

describe("preview activity", () => {
  for (const resource of ["frame", "subresource"] as const) {
    test(`${resource} requests keep the validated preview user active`, async () => {
      const { activity, listener, advance } = setup()
      const request = () => resource === "frame"
        ? new Request(`http://box.local/_preview/${token}/task/`)
        : new Request("http://box.local/assets/app.js", { headers: { referer: `http://box.local/_preview/${token}/task/` } })
      try {
        expect((await listener.handle(request())).status).toBe(200)
        advance(299_000)
        expect((await listener.handle(request())).status).toBe(200)
        advance(2_000)
        expect(activity.snapshot().users).toEqual([{ login: "alice", lastActiveAt: "2026-11-05T12:04:59.000Z" }])
        advance(298_000)
        expect(activity.snapshot().users).toEqual([])
      } finally {
        listener.close()
      }
    })
  }

  test("invalid preview tokens and task mismatches cannot refresh activity", async () => {
    const { activity, listener, advance } = setup()
    activity.record("alice")
    advance(299_000)
    try {
      for (const path of [`/_preview/22222222-2222-4222-8222-222222222222/task/`, `/_preview/${token}/other-task/`]) {
        expect((await listener.handle(new Request(`http://box.local${path}`))).status).toBe(404)
        expect((await listener.handle(new Request("http://box.local/app.js", { headers: { referer: `http://box.local${path}` } }))).status).toBe(404)
      }
      advance(1_000)
      expect(activity.snapshot().users).toEqual([])
    } finally {
      listener.close()
    }
  })
})

const OWNER = "alice"
const BOX_ID = "box_alice"
const BOX_SECRET = "alice-box-secret"
const ownBox: DirectSettings = { controlUrl: "http://control.invalid", boxId: BOX_ID, boxSecret: BOX_SECRET, managed: false }

const tokenFor = (sub: string, overrides: Partial<BoxTokenClaims> = {}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return signBoxToken(BOX_SECRET, { sub, aud: BOX_ID, iat: now, exp: now + 600, cv: "1", ...overrides })
}

/**
 * A box with an empty credential store, as after a restart, and a control plane that is "down" (unreachable), "refused"
 * (401), or "up". The app is a stub that records what it was asked to do.
 */
const restartedBox = (settings: DirectSettings = ownBox) => {
  let control: "down" | "refused" | "up" = "down"
  const fetchFn = (async () => {
    if (control === "down") throw new TypeError("fetch failed")
    if (control === "refused") return new Response(null, { status: 401 })
    return Response.json({ owner: OWNER, credentialsVersion: "1", github: "gh" })
  }) as unknown as typeof fetch
  const byUser = new Map<string, RelayCredentials>()
  const store: CredentialStoreShape = {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
  const served: Array<{ method: string; path: string; user: string | null }> = []
  const listener = makeDirectListener({
    auth: makeBoxAuth(settings, store, fetchFn),
    core: { previewTokenFor: () => Effect.succeed(null) },
    webHandler: async (request) => {
      served.push({ method: request.method, path: new URL(request.url).pathname, user: request.headers.get(BOX_USER_HEADER) })
      return Response.json({ ok: true })
    },
    runtime: Runtime.defaultRuntime as Runtime.Runtime<WsServices>,
  })
  return { listener, served, control: (next: typeof control) => void (control = next) }
}

const request = (method: string, path: string, token?: string) =>
  new Request(`http://box.local${path}`, {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: method === "GET" ? undefined : "{}",
  })

/** The status line a WebSocket upgrade is answered with, which is all that is written before the socket closes. */
const upgradeAnswer = (listener: ReturnType<typeof restartedBox>["listener"], path: string, token: string) =>
  new Promise<string>((resolve) => {
    const socket = { end: (data: string) => resolve(data) } as unknown as Duplex
    const incoming = { url: path, headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage
    listener.upgrade(incoming, socket, Buffer.alloc(0))
  })

describe("a user's own box after a restart, with the control plane down", () => {
  test("a thread read is served with the owner's identity, and marked offline", async () => {
    const box = restartedBox()
    try {
      const response = await box.listener.handle(request("GET", "/api/tasks/t1", await tokenFor(OWNER)))

      expect(response.status).toBe(200)
      expect(response.headers.get(OFFLINE_HEADER)).toBe("1")
      // A browser on the app's origin can only read the marker if the box exposes it.
      expect(response.headers.get("access-control-expose-headers")).toBe(OFFLINE_HEADER)
      expect(box.served).toEqual([{ method: "GET", path: "/api/tasks/t1", user: OWNER }])
    } finally {
      box.listener.close()
    }
  })

  test("the thread list and a thread's messages are served too", async () => {
    const box = restartedBox()
    try {
      const token = await tokenFor(OWNER)
      expect((await box.listener.handle(request("GET", "/api/tasks", token))).status).toBe(200)
      expect((await box.listener.handle(request("GET", "/api/tasks/t1/messages", token))).status).toBe(200)
      expect(box.served.map((call) => call.path)).toEqual(["/api/tasks", "/api/tasks/t1/messages"])
    } finally {
      box.listener.close()
    }
  })

  test("writes and every other route are refused before the app runs", async () => {
    const box = restartedBox()
    const token = await tokenFor(OWNER)
    const denied: Array<[string, string]> = [
      ["POST", "/api/tasks"],
      ["POST", "/api/tasks/t1/messages"],
      ["POST", "/api/tasks/t1/archive"],
      ["DELETE", "/api/tasks/t1"],
      ["PUT", "/api/settings/threads"],
      ["GET", "/api/tasks/t1/files/download"],
      ["GET", "/api/models"],
      ["GET", "/api/usage"],
      ["POST", "/api/webrtc/offer"],
      // Credential reads and capability surfaces never run offline.
      ["GET", "/api/cli-auth"],
      ["GET", "/api/tasks/t1/desktop"],
      ["GET", "/api/tasks/t1/preview/"],
      ["POST", "/api/tasks/t1/preview/session"],
    ]
    try {
      for (const [method, path] of denied) {
        const response = await box.listener.handle(request(method, path, token))
        expect(response.headers.get("access-control-expose-headers")).toBe(OFFLINE_HEADER)
        expect({ method, path, status: response.status, _tag: (await response.json())._tag }).toEqual({
          method,
          path,
          status: 503,
          _tag: "Unavailable",
        })
      }
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("a WebSocket stream is refused", async () => {
    const box = restartedBox()
    try {
      const answer = await upgradeAnswer(box.listener, "/api/tasks/t1/stream", await tokenFor(OWNER))

      expect(answer.startsWith("HTTP/1.1 503")).toBe(true)
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("a token that is expired, badly signed or for another box is refused with 401 and nothing else", async () => {
    const box = restartedBox()
    const now = Math.floor(Date.now() / 1000)
    const forged = await signBoxToken("not-the-box-secret", { sub: OWNER, aud: BOX_ID, iat: now, exp: now + 600, cv: "1" })
    try {
      for (const token of [await tokenFor(OWNER, { iat: now - 1000, exp: now - 400 }), forged, await tokenFor(OWNER, { aud: "box_other" })]) {
        expect((await box.listener.handle(request("GET", "/api/tasks/t1", token)))).toMatchObject({ status: 401 })
      }
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("preview, desktop and credential routes are refused offline even for reads", async () => {
    const box = restartedBox()
    const token = await tokenFor(OWNER)
    try {
      for (const [method, path] of [
        ["GET", "/api/cli-auth"],
        ["GET", "/api/tasks/t1/desktop"],
        ["GET", "/api/tasks/t1/preview/"],
        ["POST", "/api/tasks/t1/preview/session"],
      ] as const) {
        const response = await box.listener.handle(request(method, path, token))
        expect({ method, path, status: response.status }).toEqual({ method, path, status: 503 })
      }
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("a control plane refusal is not an outage: the read is refused, not served offline", async () => {
    const box = restartedBox()
    box.control("refused")
    try {
      const response = await box.listener.handle(request("GET", "/api/tasks/t1", await tokenFor(OWNER)))

      expect(response.status).toBe(503)
      expect(response.headers.get(OFFLINE_HEADER)).toBeNull()
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("a managed box is never served offline", async () => {
    const box = restartedBox({ ...ownBox, managed: true })
    try {
      const response = await box.listener.handle(request("GET", "/api/tasks/t1", await tokenFor(OWNER)))

      expect(response.status).toBe(503)
      expect(box.served).toEqual([])
    } finally {
      box.listener.close()
    }
  })

  test("recovery: once the control plane answers again, writes are served with full behaviour", async () => {
    const box = restartedBox()
    const token = await tokenFor(OWNER)
    try {
      expect((await box.listener.handle(request("POST", "/api/tasks", token))).status).toBe(503)

      box.control("up")
      const write = await box.listener.handle(request("POST", "/api/tasks", token))
      const read = await box.listener.handle(request("GET", "/api/tasks", token))

      expect(write.status).toBe(200)
      expect(write.headers.get(OFFLINE_HEADER)).toBeNull()
      expect(read.headers.get(OFFLINE_HEADER)).toBeNull()
      expect(box.served.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/tasks", "GET /api/tasks"])
    } finally {
      box.listener.close()
    }
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Runtime } from "effect"
import { type BoxTokenClaims, signBoxToken } from "@cloudagents/protocol"
import type { CoreShape } from "../core/service"
import type { CredentialStoreShape } from "../credentials"
import { makeWebHandler } from "../http/router"
import type { WsServices } from "../http/streams"
import type { ModelDiscoveryShape } from "../model-discovery"
import { makeBoxAuth, type DirectSettings } from "./auth"
import { makeDirectListener, OFFLINE_HEADER } from "./listener"

// The real router and the real listener gate, with the control plane unreachable and an empty credential store (a box
// just restarted). The core and the model catalogue are recording stubs, so each test sees exactly which requests the
// app is asked to run and as whom.

const OWNER = "alice"
const BOX_ID = "box_alice"
const BOX_SECRET = "alice-box-secret"
const settings: DirectSettings = { controlUrl: "http://control.invalid", boxId: BOX_ID, boxSecret: BOX_SECRET, managed: false }

const tokenFor = (sub: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  const claims: BoxTokenClaims = { sub, aud: BOX_ID, iat: now, exp: now + 600, cv: "1" }
  return signBoxToken(BOX_SECRET, claims)
}

const restartedBox = () => {
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = []
  const recordingCore = new Proxy(
    {},
    {
      get: (_target, method: string) => (...args: unknown[]) => {
        calls.push({ method, args })
        return Effect.succeed([])
      },
    },
  ) as unknown as CoreShape
  const models = {
    get: () => {
      calls.push({ method: "models", args: [] })
      return Effect.succeed({ models: [], sources: [] })
    },
    list: () => Effect.succeed({ models: [], sources: [] }),
  } as unknown as ModelDiscoveryShape
  const store: CredentialStoreShape = {
    get: () => Effect.succeed(null),
    set: () => Effect.void,
  } as unknown as CredentialStoreShape
  // Unreachable control plane: the fetch rejects, which is the outage the offline reads are for.
  const fetchFn = (async () => {
    throw new TypeError("fetch failed")
  }) as unknown as typeof fetch
  const handler = Effect.runSync(
    makeWebHandler(recordingCore, {} as never, {} as never, models),
  )
  const listener = makeDirectListener({
    auth: makeBoxAuth(settings, store, fetchFn),
    core: { previewTokenFor: () => Effect.succeed(null) },
    webHandler: (request) => handler(request),
    runtime: Runtime.defaultRuntime as Runtime.Runtime<WsServices>,
  })
  return { listener, calls }
}

const request = (method: string, path: string, token: string): Request =>
  new Request(`http://box.local${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: method === "GET" ? undefined : "{}",
  })

describe("offline reads through the real router", () => {
  test("the thread list runs the core as the token's owner, marked offline", async () => {
    const box = restartedBox()
    try {
      const response = await box.listener.handle(request("GET", "/api/tasks", await tokenFor(OWNER)))
      expect(response.status).toBe(200)
      expect(response.headers.get(OFFLINE_HEADER)).toBe("1")
      // The app is a cross-origin page: it can read the mark only when the box exposes it.
      expect(response.headers.get("access-control-expose-headers")).toContain(OFFLINE_HEADER)
      expect(box.calls).toEqual([{ method: "listTasks", args: [OWNER] }])
    } finally {
      box.listener.close()
    }
  })

  test("a thread's messages are read through the router as the owner", async () => {
    const box = restartedBox()
    try {
      const response = await box.listener.handle(request("GET", "/api/tasks/t1/messages", await tokenFor(OWNER)))
      expect(response.status).toBe(200)
      expect(box.calls.map((call) => call.method)).toEqual(["listMessages"])
    } finally {
      box.listener.close()
    }
  })

  test("writes never reach the core, and other reads are refused before the router", async () => {
    const token = await tokenFor(OWNER)
    const refused: Array<[string, string]> = [
      ["POST", "/api/tasks"],
      ["DELETE", "/api/tasks/t1"],
      ["PATCH", "/api/tasks/t1"],
      ["POST", "/api/tasks/t1/messages"],
      ["GET", "/api/models"],
      ["GET", "/api/tasks/t1/diff"],
    ]
    for (const [method, path] of refused) {
      const box = restartedBox()
      try {
        const response = await box.listener.handle(request(method, path, token))
        expect(response.status).toBe(503)
        expect(response.headers.get(OFFLINE_HEADER)).toBe("1")
        expect(box.calls).toEqual([])
      } finally {
        box.listener.close()
      }
    }
  })

  test("the box cannot check the owner while offline: the read runs as the token's subject, and the core scopes it", async () => {
    // Assumption, not a check: control mints a token only for the box's owner, and the token is signed with this box's
    // secret, so the subject is trusted. The core then limits a read to threads whose owner is that subject.
    const box = restartedBox()
    try {
      await box.listener.handle(request("GET", "/api/tasks", await tokenFor("bob")))
      expect(box.calls).toEqual([{ method: "listTasks", args: ["bob"] }])
    } finally {
      box.listener.close()
    }
  })
})

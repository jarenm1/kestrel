import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import { Schema } from "effect"
import { BOX_ID_HEADER, BOX_TURN_PATH, BoxTurnCredentials } from "@cloudagents/protocol"
import type { Env } from "./env"
import { MAX_TURN_CREDENTIAL_CACHE, TURN_CREDENTIAL_REFRESH_MS, TURN_CREDENTIAL_TTL_SECONDS } from "./turn"

// The Worker and Hub import `cloudflare:workers`, so the mock must be registered before either module loads.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default

const managedBoxVerify = async (id: string, secret: string): Promise<boolean> =>
  (id === "managed-1" && secret === "managed-secret") ||
  (id.startsWith("m-") && secret === "m-secret") ||
  (id.startsWith("bulk-") && secret === "bulk-secret")

const boxVerify = async (id: string, secret: string): Promise<boolean> =>
  (id === "byob-1" && secret === "byob-secret") || (id.startsWith("b-") && secret === "b-secret")

const stub = {
  managedBoxVerify,
  boxVerify,
  managedBoxTurnIdentity: async (id: string, secret: string): Promise<string | null> =>
    (await stub.managedBoxVerify(id, secret)) ? `managed:${id}:0` : null,
  boxTurnIdentity: async (id: string, secret: string): Promise<string | null> =>
    (await stub.boxVerify(id, secret)) ? `box:${id}:0` : null,
}
const HUB = { idFromName: () => "main", get: () => stub }

const envWith = (vars: Partial<Env> = {}): Env =>
  ({
    BOX_TOKEN: "relay-secret",
    KESTREL_TURN_KEY_ID: "turn-key",
    KESTREL_TURN_API_TOKEN: "provider-token",
    HUB,
    ...vars,
  }) as unknown as Env

const env = envWith()

const ICE_SERVERS = [
  {
    urls: [
      "stun:stun.cloudflare.com:3478",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp",
    ],
    username: "turn-user",
    credential: "turn-credential",
  },
]

const providerResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const calls: { url: string; init: RequestInit }[] = []
let respond: () => Promise<Response> = async () => providerResponse({ iceServers: ICE_SERVERS })
const realFetch = globalThis.fetch

beforeEach(() => {
  calls.length = 0
  respond = async () => providerResponse({ iceServers: ICE_SERVERS })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

const send = (headers: Record<string, string> = {}, overrides: Env = env): Promise<Response> =>
  worker.fetch(new Request(`https://app.example${BOX_TURN_PATH}`, { method: "POST", headers }), overrides)

const relayHeaders = { authorization: "Bearer relay-secret" }
const managedHeaders = { authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "managed-1" }
const byobHeaders = { authorization: "Bearer byob-secret", [BOX_ID_HEADER]: "byob-1" }

describe("POST /box/turn", () => {
  test("refuses a caller that proves no box, before any provider call", async () => {
    const unauthorized = await send()
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ issue: "control-rejected" })
    expect((await send({ authorization: "Bearer wrong" })).status).toBe(401)
    // An id without a secret, or a secret for a box in neither registry.
    expect((await send({ authorization: "Bearer managed-secret" })).status).toBe(401)
    expect((await send({ authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "byob-1" })).status).toBe(401)
    expect((await send({ authorization: "Bearer not-the-secret", [BOX_ID_HEADER]: "byob-1" })).status).toBe(401)
    expect(
      (await worker.fetch(new Request(`https://app.example${BOX_TURN_PATH}`, { method: "GET", headers: relayHeaders }), env))
        .status,
    ).toBe(405)
    expect(calls).toHaveLength(0)
  })

  test("issues credentials to the relay box, a managed box and a registered user box", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const now = Date.now()

    const relay = await send(relayHeaders)
    expect(relay.status).toBe(200)
    expect(relay.headers.get("cache-control")).toBe("no-store")
    const credentials = Schema.decodeUnknownSync(BoxTurnCredentials)(await relay.json())
    expect(credentials.expiresAt).toBe(now + TURN_CREDENTIAL_TTL_SECONDS * 1000)
    expect(credentials.iceServers).toEqual(ICE_SERVERS)

    // The provider was called as its API requires, and its token is neither echoed nor put in the body.
    expect(calls[0]?.url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key/credentials/generate-ice-servers",
    )
    expect(calls[0]?.init.method).toBe("POST")
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer provider-token")
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ ttl: TURN_CREDENTIAL_TTL_SECONDS })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(credentials)).not.toContain("provider-token")

    const managed = await send(managedHeaders)
    expect(managed.status).toBe(200)
    expect(Schema.is(BoxTurnCredentials)(await managed.json())).toBe(true)

    const byob = await send(byobHeaders)
    expect(byob.status).toBe(200)
    expect(Schema.is(BoxTurnCredentials)(await byob.json())).toBe(true)
    expect(calls).toHaveLength(3)
  })

  test("answers 204 without a provider and 502 when only half of it is configured", async () => {
    const absent = envWith({ KESTREL_TURN_KEY_ID: undefined, KESTREL_TURN_API_TOKEN: undefined })
    const withoutProvider = await send({ authorization: "Bearer m-secret", [BOX_ID_HEADER]: "m-absent" }, absent)
    expect(withoutProvider.status).toBe(204)
    expect(withoutProvider.headers.get("cache-control")).toBe("no-store")

    const missingToken = envWith({ KESTREL_TURN_API_TOKEN: undefined })
    const halfConfigured = await send({ authorization: "Bearer m-secret", [BOX_ID_HEADER]: "m-half" }, missingToken)
    expect(halfConfigured.status).toBe(502)
    const body = (await halfConfigured.json()) as { _tag: string; message: string; issue?: string }
    expect(body._tag).toBe("BadGateway")
    expect(body.issue).toBe("configuration-incomplete")
    expect(body.message).toContain("KESTREL_TURN_KEY_ID")
    expect(body.message).toContain("KESTREL_TURN_API_TOKEN")
    expect(body.message).not.toContain("provider-token")
    expect(calls).toHaveLength(0)
  })

  test("caches per box until five minutes before expiry, and never serves a failed authentication", async () => {
    const start = Date.parse("2026-02-01T00:00:00.000Z")
    setSystemTime(new Date(start))
    const headersFor = (id: string) => ({ authorization: "Bearer m-secret", [BOX_ID_HEADER]: id })

    expect((await send(headersFor("m-cache-a"))).status).toBe(200)
    expect((await send(headersFor("m-cache-a"))).status).toBe(200)
    expect(calls).toHaveLength(1)

    // Each box is cached apart from the others.
    expect((await send(headersFor("m-cache-b"))).status).toBe(200)
    expect(calls).toHaveLength(2)

    // Authorization precedes the cache: a wrong secret neither reads it nor causes a provider call.
    expect((await send({ authorization: "Bearer wrong", [BOX_ID_HEADER]: "m-cache-a" })).status).toBe(401)
    expect(calls).toHaveLength(2)

    // More than five minutes left: still the cached credentials.
    setSystemTime(new Date(start + TURN_CREDENTIAL_TTL_SECONDS * 1000 - TURN_CREDENTIAL_REFRESH_MS - 1))
    expect((await send(headersFor("m-cache-a"))).status).toBe(200)
    expect(calls).toHaveLength(2)

    // At exactly five minutes left they are refreshed, with a new full TTL.
    setSystemTime(new Date(start + TURN_CREDENTIAL_TTL_SECONDS * 1000 - TURN_CREDENTIAL_REFRESH_MS))
    const refreshed = await send(headersFor("m-cache-a"))
    expect(refreshed.status).toBe(200)
    expect(calls).toHaveLength(3)
    const credentials = Schema.decodeUnknownSync(BoxTurnCredentials)(await refreshed.json())
    expect(credentials.expiresAt).toBe(
      start + TURN_CREDENTIAL_TTL_SECONDS * 1000 - TURN_CREDENTIAL_REFRESH_MS + TURN_CREDENTIAL_TTL_SECONDS * 1000,
    )
  })

  test("reports provider failures safely and asks again after one", async () => {
    const cases: { response: () => Promise<Response>; message: string }[] = [
      { response: async () => providerResponse("not json"), message: "unusable response" },
      { response: async () => providerResponse({ iceServers: [] }), message: "unusable response" },
      {
        response: async () => providerResponse({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }),
        message: "unusable response",
      },
      {
        response: async () => providerResponse({ iceServers: [{ urls: ["http://example.com"] }] }),
        message: "unusable response",
      },
      {
        response: async () => providerResponse({ iceServers: [{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"] }] }),
        message: "unusable response",
      },
      {
        response: async () => providerResponse({
          iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "user", credential: "password" }],
        }),
        message: "unusable response",
      },
      { response: async () => providerResponse({ iceServers: "nope" }), message: "unusable response" },
      {
        response: async () => providerResponse({ iceServers: ICE_SERVERS }, 500),
        message: "provider is unavailable",
      },
      {
        response: async () => {
          throw new Error("provider rejected provider-token")
        },
        message: "provider is unavailable",
      },
    ]

    for (const [index, testCase] of cases.entries()) {
      respond = testCase.response
      const response = await send({ authorization: "Bearer b-secret", [BOX_ID_HEADER]: `b-fail-${index}` })
      expect(response.status).toBe(502)
      const text = await response.text()
      expect(text).not.toContain("provider-token")
      expect(text).not.toContain("http://example.com")
      expect(text).not.toContain("not json")
      const body = JSON.parse(text) as { _tag: string; message: string; issue?: string }
      expect(body._tag).toBe("BadGateway")
      expect(body.message).toContain(testCase.message)
      expect(body.issue).toBe(testCase.message === "provider is unavailable" ? "provider-unavailable" : "provider-unusable")
    }
    // Failures are not cached: every retry asked the provider again.
    expect(calls).toHaveLength(cases.length)
  })

  test("shares one provider call between concurrent requests for the same box", async () => {
    // Hold both requests' authentication until each has arrived, so both continue into the cache in order.
    const bothArrived = Promise.withResolvers<void>()
    const successful = stub.managedBoxVerify
    let arrived = 0
    stub.managedBoxVerify = async (id, secret) => {
      const valid = await successful(id, secret)
      if (id !== "m-flight") return valid
      if ((arrived += 1) === 2) bothArrived.resolve()
      await bothArrived.promise
      return valid
    }
    try {
      const headers = { authorization: "Bearer m-secret", [BOX_ID_HEADER]: "m-flight" }
      const responses = await Promise.all([send(headers), send(headers)])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(calls).toHaveLength(1)
      const bodies = await Promise.all(
        responses.map(async (response) => Schema.decodeUnknownSync(BoxTurnCredentials)(await response.json())),
      )
      expect(bodies[0]).toEqual(bodies[1])
    } finally {
      stub.managedBoxVerify = successful
    }
  })

  test("keeps the cache bounded, refreshing a box whose entry was evicted", async () => {
    const headersFor = (id: string) => ({ authorization: "Bearer bulk-secret", [BOX_ID_HEADER]: id })
    for (let index = 0; index <= MAX_TURN_CREDENTIAL_CACHE; index++) {
      expect((await send(headersFor(`bulk-${index}`))).status).toBe(200)
    }
    expect(calls).toHaveLength(MAX_TURN_CREDENTIAL_CACHE + 1)
    // bulk-0 was the oldest when the cache filled, so it is gone and the next request asks the provider again.
    expect((await send(headersFor("bulk-0"))).status).toBe(200)
    expect(calls).toHaveLength(MAX_TURN_CREDENTIAL_CACHE + 2)
  })
})

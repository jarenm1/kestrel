import { afterEach, describe, expect, test } from "bun:test"
import { BOX_ID_HEADER, BOX_TURN_PATH, type DesktopRtcIceServer } from "@cloudagents/protocol"
import type { ServerConfig } from "../config"
import { mintIceServers, type WebRtcSettings } from "./webrtc"
import { hasExplicitTurn, managedTurn, sessionIceServers } from "./turn"

const PROVIDER_STUN: DesktopRtcIceServer = { urls: ["stun:managed-stun.example.com:3478"] }
const MANAGED_TURN: DesktopRtcIceServer = {
  urls: ["turns:turn.cloudflare.com:443?transport=tcp"],
  username: "managed-user",
  credential: "managed-pass",
}
const MANAGED: DesktopRtcIceServer[] = [PROVIDER_STUN, MANAGED_TURN]
const STUN: DesktopRtcIceServer[] = [{ urls: ["stun:stun.example.com:3478"] }]
const NOW_S = 1_700_000_000
const IN_AN_HOUR = 60 * 60 * 1000

const settings = (overrides: Partial<WebRtcSettings> = {}): WebRtcSettings => ({
  iceServers: STUN,
  turn: null,
  policy: "all",
  portRange: null,
  hostAddresses: [],
  denyPrivate: false,
  ...overrides,
})

const config = (
  direct: ServerConfig["direct"] = null,
  relay: ServerConfig["relay"] = null,
): ServerConfig => ({ direct, relay } as ServerConfig)

const direct = (controlUrl: string): ServerConfig["direct"] => ({
  controlUrl,
  boxId: "box-1",
  boxSecret: "box-secret",
  managed: false,
})

let servers: Array<{ stop: (force?: boolean) => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** A real control-plane endpoint, so URL joining, method before body, and headers are exercised end to end. */
const endpoint = (handler: (request: Request) => Response | Promise<Response>): string => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

const credentials = (expiresAt = Date.now() + IN_AN_HOUR) =>
  Response.json({ iceServers: MANAGED, expiresAt })

describe("managedTurn", () => {
  test("registered boxes receive managed TURN using their own identity", async () => {
    const controlUrl = endpoint((request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== BOX_TURN_PATH) {
        return new Response(null, { status: 404 })
      }
      const direct =
        request.headers.get("authorization") === "Bearer box-secret" &&
        request.headers.get(BOX_ID_HEADER) === "box-1"
      const relay =
        request.headers.get("authorization") === "Bearer relay-token" &&
        request.headers.get(BOX_ID_HEADER) === null
      return direct || relay ? credentials() : new Response(null, { status: 401 })
    })

    const directViewer = await sessionIceServers(settings(), managedTurn(config(direct(controlUrl))), "thread-direct", NOW_S)
    expect(directViewer.warning).toBeNull()
    expect(directViewer.iceServers).toEqual([...STUN, ...MANAGED])
    expect(directViewer.turn).toEqual({ source: "managed", status: "configured", failure: null })
    // The box's own peer takes the same list, and knows the relay is the control plane's.
    expect(directViewer.managed).toBe(true)

    const relayViewer = await sessionIceServers(
      settings(),
      managedTurn(config(null, { controlUrl, boxToken: "relay-token" })),
      "thread-relay",
      NOW_S,
    )
    expect(relayViewer.warning).toBeNull()
    expect(relayViewer.iceServers).toEqual([...STUN, ...MANAGED])
    expect(relayViewer.turn).toEqual({ source: "managed", status: "configured", failure: null })
    expect(relayViewer.managed).toBe(true)
  })

  test("a standalone box has no control-plane identity and keeps its own servers", async () => {
    const turn = managedTurn(config())

    expect(await turn.servers()).toEqual({ iceServers: null, warning: null })
    const servers = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    expect(servers.iceServers).toEqual(STUN)
    expect(servers.managed).toBe(false)
    expect(servers.turn).toEqual({ source: "none", status: "not-configured", failure: null })
  })

  test("a failed provider fetch is a managed credential failure without provider text", async () => {
    const controlUrl = endpoint(() => new Response("provider down", { status: 503 }))
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await sessionIceServers(settings(), turn, "thread-1", NOW_S)

    expect(result.iceServers).toEqual(STUN)
    expect(result.turn).toEqual({ source: "managed", status: "unavailable", failure: "turn-credentials" })
    // Only the enumerated outcome travels; the provider's text stays in the warning log.
    expect(JSON.stringify(result.turn)).not.toContain("503")
    expect(JSON.stringify(result.turn)).not.toContain("provider down")
  })

  test("rejects expired credentials and does not cache the rejection", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return Response.json({ iceServers: MANAGED, expiresAt: Date.now() - 1 })
    })
    const turn = managedTurn(config(direct(controlUrl)))

    const first = await turn.servers()
    const rejected = {
      iceServers: null,
      warning: "managed TURN unavailable: control plane sent expired TURN credentials",
    } as const
    expect(first).toEqual(rejected)
    const viewer = await sessionIceServers(settings(), turn, "thread-expired", NOW_S)
    expect(viewer.iceServers).toEqual(STUN)
    expect(viewer.warning).toBe(rejected.warning)
    expect(calls).toBe(2)
  })

  test("rejects a structurally valid answer with no authenticated TURN server", async () => {
    const controlUrl = endpoint(() =>
      Response.json({
        iceServers: [
          { urls: ["stun:provider-stun.example.com:3478"] },
          { urls: ["turn:no-credentials.example.com:3478"] },
        ],
        expiresAt: Date.now() + IN_AN_HOUR,
      }),
    )
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    expect(result.iceServers).toEqual(STUN)
    expect(result.warning).toBe("managed TURN unavailable: control plane sent no usable TURN credentials")
  })

  test("keeps valid STUN and drops empty, non-ICE, and unauthenticated TURN entries", async () => {
    const controlUrl = endpoint(() =>
      Response.json({
        iceServers: [
          { urls: [] },
          { urls: ["https://not-an-ice-server.example"] },
          { urls: ["stun:provider-stun.example.com:3478"], username: "", credential: "" },
          { urls: ["turn:no-credentials.example.com:3478"], username: "", credential: "" },
          MANAGED_TURN,
        ],
        expiresAt: Date.now() + IN_AN_HOUR,
      }),
    )
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    expect(result.warning).toBeNull()
    expect(result.iceServers).toEqual([
      ...STUN,
      { urls: ["stun:provider-stun.example.com:3478"] },
      MANAGED_TURN,
    ])
  })

  test("caches credentials until five minutes before the provider's expiry", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return credentials()
    })
    const turn = managedTurn(config(direct(controlUrl)))

    const first = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    const second = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    expect(first.iceServers).toEqual([...STUN, ...MANAGED])
    expect(second.iceServers).toEqual([...STUN, ...MANAGED])
    expect(calls).toBe(1)
  })

  test("does not cache credentials that are already inside the refresh margin", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return credentials(Date.now() + 4 * 60 * 1000)
    })
    const turn = managedTurn(config(direct(controlUrl)))

    expect((await sessionIceServers(settings(), turn, "thread-1", NOW_S)).iceServers).toEqual([...STUN, ...MANAGED])
    expect((await sessionIceServers(settings(), turn, "thread-1", NOW_S)).iceServers).toEqual([...STUN, ...MANAGED])
    expect(calls).toBe(2)
  })

  test("coalesces concurrent refreshes into one control-plane request", async () => {
    let calls = 0
    const sawRequest = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const controlUrl = endpoint(async () => {
      calls++
      sawRequest.resolve()
      await gate.promise
      return credentials()
    })
    const turn = managedTurn(config(direct(controlUrl)))

    const pending = Promise.all([turn.servers(), turn.servers()])
    await sawRequest.promise
    expect(calls).toBe(1)
    gate.resolve()
    const [first, second] = await pending
    expect(first.iceServers).toEqual(MANAGED)
    expect(second.iceServers).toEqual(MANAGED)
  })

  test("a transient failure is not cached: the next config request retries and succeeds", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return calls === 1 ? new Response("provider unavailable", { status: 502 }) : credentials()
    })
    const turn = managedTurn(config(direct(controlUrl)))

    const failed = await turn.servers()
    expect(failed.iceServers).toBeNull()
    expect(failed.warning).toContain("502")
    const retried = await turn.servers()
    expect(retried.iceServers).toEqual(MANAGED)
    expect(retried.warning).toBeNull()
    expect(calls).toBe(2)
  })

  test("a rejected box identity is a sanitized 401 warning", async () => {
    const controlUrl = endpoint(() => new Response("invalid box", { status: 401 }))
    const turn = managedTurn(config(direct(controlUrl)))

    expect(await turn.servers()).toEqual({
      iceServers: null,
      warning: "managed TURN unavailable: control plane answered 401",
    })
  })

  test("a 204 means no provider is configured, so the box keeps its own servers without a warning", async () => {
    const controlUrl = endpoint(() => new Response(null, { status: 204 }))
    const turn = managedTurn(config(direct(controlUrl)))

    expect(await turn.servers()).toEqual({ iceServers: null, warning: null })
    const servers = await sessionIceServers(settings(), turn, "thread-1", NOW_S)
    expect(servers.iceServers).toEqual(STUN)
    expect(servers.managed).toBe(false)
    expect(servers.turn).toEqual({ source: "none", status: "not-configured", failure: null })
  })

  test("a malformed answer is a sanitized warning, not a crash or a fabricated relay", async () => {
    const controlUrl = endpoint(() => Response.json({ iceServers: [{ urls: "not-a-list" }], expiresAt: "later" }))
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await turn.servers()
    expect(result.iceServers).toBeNull()
    expect(result.warning).toBe("managed TURN unavailable: control plane sent an unexpected TURN answer")
    expect(result.warning).not.toContain("box-secret")
  })
})

describe("sessionIceServers", () => {
  test("appends managed TURN to the box's local STUN without requiring per-box TURN settings", async () => {
    const controlUrl = endpoint(() => credentials())
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await sessionIceServers(settings(), turn, "thread-1", NOW_S)

    expect(result.warning).toBeNull()
    expect(result.iceServers).toEqual([...STUN, ...MANAGED])
    expect(result.turn).toEqual({ source: "managed", status: "configured", failure: null })
  })

  test("keeps local STUN when the control plane fails, without fabricating a relay", async () => {
    const controlUrl = endpoint(() => new Response(null, { status: 503 }))
    const turn = managedTurn(config(direct(controlUrl)))

    const result = await sessionIceServers(settings(), turn, "thread-1", NOW_S)

    expect(result.iceServers).toEqual(STUN)
    expect(result.warning).toBe("managed TURN unavailable: control plane answered 503")
    expect(result.turn).toEqual({ source: "managed", status: "unavailable", failure: "turn-credentials" })
  })

  test("keeps static local TURN credentials and never asks the control plane", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return credentials()
    })
    const turn = managedTurn(config(direct(controlUrl)))
    const local = settings({
      iceServers: [{ urls: ["turns:static-turn.example.com:443"], username: "local-user", credential: "local-pass" }],
    })

    const result = await sessionIceServers(local, turn, "thread-1", NOW_S)

    expect(result.iceServers).toEqual([...local.iceServers])
    expect(result.turn).toEqual({ source: "local", status: "configured", failure: null })
    expect(calls).toBe(0)
  })

  test("reports an explicit local TURN URL without credentials as unavailable", async () => {
    const turn = managedTurn(config(direct(endpoint(() => credentials()))))
    const local = settings({ iceServers: [{ urls: ["turns:static-turn.example.com:443"] }] })

    const result = await sessionIceServers(local, turn, "thread-1", NOW_S)

    expect(result.iceServers).toEqual([...local.iceServers])
    expect(result.turn).toEqual({ source: "local", status: "unavailable", failure: "turn-credentials" })
  })

  test("reports a REST secret with no TURN URL as unavailable instead of asking the control plane", async () => {
    let calls = 0
    const turn = managedTurn(
      config(
        direct(
          endpoint(() => {
            calls++
            return credentials()
          }),
        ),
      ),
    )
    const local = settings({ iceServers: [], turn: { urls: ["stun:local-stun.example.com:3478"], secret: "local-secret" } })

    const result = await sessionIceServers(local, turn, "thread-1", NOW_S)

    expect(result.turn).toEqual({ source: "local", status: "unavailable", failure: "turn-credentials" })
    expect(calls).toBe(0)
  })

  test("keeps a local TURN REST secret and its minted credentials, with managed TURN excluded", async () => {
    let calls = 0
    const controlUrl = endpoint(() => {
      calls++
      return credentials()
    })
    const turn = managedTurn(config(direct(controlUrl)))
    const local = settings({ iceServers: [], turn: { urls: ["turns:local-turn.example.com:443"], secret: "local-secret" } })

    const result = await sessionIceServers(local, turn, "thread-1", NOW_S)

    expect(result.iceServers).toEqual(mintIceServers(local, "thread-1", NOW_S))
    expect(result.turn).toEqual({ source: "local", status: "configured", failure: null })
    expect(calls).toBe(0)
  })

  test("treats STUN-only settings as not being explicit TURN", () => {
    expect(hasExplicitTurn(settings())).toBe(false)
    expect(hasExplicitTurn(settings({ iceServers: [{ urls: ["turn:turn.example.com:3478"] }] }))).toBe(true)
    expect(hasExplicitTurn(settings({ iceServers: [{ urls: ["TURNS:turn.example.com:443"] }] }))).toBe(true)
  })
})

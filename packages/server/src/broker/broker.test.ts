import { describe, expect, test } from "bun:test"
import { createServer, request } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Layer } from "effect"
import type { RelayCredentials } from "@cloudagents/protocol"
import { Config } from "../config"
import { CredentialStore } from "../credentials"
import {
  BROKER_PROVIDERS,
  BROKER_UPSTREAMS,
  brokerApiFor,
  brokerEnv,
  credentialFor,
  CredentialBroker,
  CredentialBrokerLive,
  DEFAULT_BROKER_API,
  DEFAULT_BROKER_HARNESS,
  type BrokerGrant,
  type BrokerProvider,
  type CredentialBrokerShape,
} from "./index"
import { brokerTarget, handleBroker } from "./handler"

const BASE = "http://127.0.0.1:8787/broker/run-token"

const grant = (providers: readonly BrokerProvider[], extra: Partial<BrokerGrant> = {}): BrokerGrant => ({
  runId: "run",
  user: "octocat",
  providers,
  opencodeSession: "ses_kestrelrun",
  opencodeGoKey: null,
  ...extra,
})

const brokerOf = (overrides: Partial<CredentialBrokerShape> = {}): CredentialBrokerShape => ({
  issue: () => Effect.die("unused"),
  revoke: () => Effect.void,
  grantForToken: () => Effect.succeed(null),
  onRevoke: () => () => undefined,
  upstreamKey: () => Effect.succeed("real-key"),
  ...overrides,
})

/** The real broker with a fixed sandbox port and no control-plane credentials. */
const brokerLayer = CredentialBrokerLive.pipe(
  Layer.provide(
    Layer.merge(
      Layer.succeed(Config, { sandboxPort: 8787 } as never),
      Layer.succeed(CredentialStore, { get: () => Effect.succeed(null), set: () => Effect.void }),
    ),
  ),
)

/** A local stand-in for one upstream: records what the broker forwarded and answers OK. */
const capture = () => {
  const seen: Array<{ path: string; headers: Headers }> = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push({ path: url.pathname + url.search, headers: req.headers })
      return new Response("ok")
    },
  })
  return { seen, server, url: `http://127.0.0.1:${server.port}` }
}

describe("broker provider mapping", () => {
  test("an OpenAI route drops the broker's literal /v1 and keeps the provider's own base", () => {
    expect(brokerTarget("openai", "openai", "/v1/responses")).toMatchObject({
      upstream: BROKER_UPSTREAMS.openai.openai?.responses,
      path: "/responses",
    })
    expect(brokerTarget("zai", "openai", "/v1/chat/completions")?.path).toBe("/chat/completions")
    expect(brokerTarget("zai", "openai", "/v1/responses")?.upstream.base).toBe("https://api.z.ai/api/v1")
    expect(brokerTarget("deepseek", "openai", "/v1/responses")).toMatchObject({
      upstream: BROKER_UPSTREAMS.deepseek.openai?.responses,
      path: "/responses",
    })
    expect(brokerTarget("openrouter", "openai", "/v1/chat/completions")?.path).toBe("/chat/completions")
    expect(brokerTarget("anthropic", "anthropic", "/v1/messages")?.path).toBe("/v1/messages")
    expect(brokerTarget("anthropic", "openai", "/v1/responses")).toBeNull()
    expect(brokerTarget("openai", "anthropic", "/v1/messages")).toBeNull()
  })
})

describe("broker env", () => {
  const harnesses = ["claude", "codex", "opencode"] as const
  const gateways = ["openrouter", "zai", "deepseek", "minimax", "moonshot"] as const
  const pairs: ReadonlyArray<readonly [BrokerProvider, (typeof harnesses)[number]]> = [
    ["anthropic", "claude"],
    ["anthropic", "opencode"],
    ["openai", "codex"],
    ["openai", "opencode"],
    ...gateways.flatMap((provider) => harnesses.map((harness) => [provider, harness] as const)),
    ["opencode-go", "opencode"],
    ["opencode-go", "claude"],
    ["opencode-go", "codex"],
  ]

  const expected = (provider: BrokerProvider, harness: (typeof harnesses)[number]): Record<string, string> => {
    if (harness === "opencode") return { KESTREL_BROKER_TOKEN: "t" }
    const nativeVendor =
      (provider === "anthropic" && harness === "claude") || (provider === "openai" && harness === "codex")
    if (nativeVendor) {
      return {
        ANTHROPIC_BASE_URL: `${BASE}/anthropic`,
        ANTHROPIC_API_KEY: "t",
        OPENAI_BASE_URL: `${BASE}/openai/v1`,
        OPENAI_API_KEY: "t",
      }
    }
    if (harness === "codex") {
      return { OPENAI_BASE_URL: `${BASE}/${provider}/openai/v1`, OPENAI_API_KEY: "t" }
    }
    return {
      // Only the Go gateway has no legacy `/provider` Anthropic path.
      ANTHROPIC_BASE_URL: provider === "opencode-go" ? `${BASE}/opencode-go/anthropic` : `${BASE}/${provider}`,
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_API_KEY: "",
    }
  }

  test("every producible provider×harness gets the env its own CLI reads", () => {
    for (const [provider, harness] of pairs) {
      expect(brokerEnv(provider, BASE, "t", harness)).toEqual(expected(provider, harness))
      if (DEFAULT_BROKER_HARNESS[provider] === harness) {
        expect(brokerEnv(provider, BASE, "t")).toEqual(expected(provider, harness))
      }
    }
  })

  test("the legacy API is derived from the one provider→harness table", () => {
    for (const provider of BROKER_PROVIDERS) {
      expect(DEFAULT_BROKER_API[provider]).toBe(brokerApiFor(DEFAULT_BROKER_HARNESS[provider]))
    }
  })
})

describe("broker issuance", () => {
  test("Go credentials stay provider-scoped and revocable while resumed runs retain their session", async () => {
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* CredentialBroker
        const lease = yield* broker.issue("run-1", "octocat", "opencode-go", {
          harness: "claude",
          opencodeGoKey: "go-key",
          sessionId: "task-1",
        })
        const grant = yield* broker.grantForToken(lease.token)
        // A resumed run of the same conversation keeps Go's session.
        const resumed = yield* broker.issue("run-1b", "octocat", "opencode-go", {
          harness: "codex",
          opencodeGoKey: "go-key",
          sessionId: "task-1",
        })
        const resumedGrant = yield* broker.grantForToken(resumed.token)
        const other = yield* broker.issue("run-2", "octocat", "openrouter", {
          harness: "codex",
          opencodeGoKey: "must-not-stick",
        })
        const otherGrant = yield* broker.grantForToken(other.token)
        yield* broker.revoke("run-1")
        return { lease, grant, resumedGrant, other, otherGrant, revoked: yield* broker.grantForToken(lease.token) }
      }).pipe(Effect.provide(brokerLayer)),
    )
    expect(issued.grant).toMatchObject({
      runId: "run-1",
      providers: ["opencode-go"],
      opencodeGoKey: "go-key",
      opencodeSession: "ses_task-1",
    })
    expect(issued.resumedGrant?.opencodeSession).toBe("ses_task-1")
    // Another provider never keeps a Go key handed to the same call.
    expect(issued.otherGrant?.opencodeGoKey).toBeNull()
    expect(issued.revoked).toBeNull()
  })

  test.each(["anthropic", "openai"] as const)("an OpenCode %s route cannot use the other vendor's credential", async (provider) => {
    const { lease, grant } = await Effect.runPromise(
      Effect.gen(function* () {
        const broker = yield* CredentialBroker
        const lease = yield* broker.issue("run-3", "octocat", provider, { harness: "opencode" })
        return { lease, grant: yield* broker.grantForToken(lease.token) }
      }).pipe(Effect.provide(brokerLayer)),
    )
    expect(lease.env).toEqual({ KESTREL_BROKER_TOKEN: lease.token })
    expect(grant?.providers).toEqual([provider])
  })
})

describe("broker requests", () => {
  test("gateway requests keep the provider path and carry the key as a bearer token", async () => {
    const upstream = capture()
    const previous = BROKER_UPSTREAMS.openrouter
    BROKER_UPSTREAMS.openrouter = {
      ...previous,
      anthropic: { ...previous.anthropic!, base: `${upstream.url}/api` },
    }
    const broker = brokerOf({ grantForToken: () => Effect.succeed(grant(["openrouter"])) })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    const port = (box.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/openrouter/v1/messages?beta=1`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client", "x-api-key": "client" },
        body: '{"model":"anthropic/claude-sonnet-5.5"}',
      })
      expect(await response.text()).toBe("ok")
      expect(upstream.seen).toHaveLength(1)
      expect(upstream.seen[0]?.path).toBe("/api/v1/messages?beta=1")
      expect(upstream.seen[0]?.headers.get("authorization")).toBe("Bearer real-key")
      expect(upstream.seen[0]?.headers.get("x-api-key")).toBeNull()
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
      upstream.server.stop(true)
      BROKER_UPSTREAMS.openrouter = previous
    }
  })

  test("Anthropic requests inject the key in x-api-key", async () => {
    const upstream = capture()
    const previous = BROKER_UPSTREAMS.anthropic
    BROKER_UPSTREAMS.anthropic = {
      ...previous,
      anthropic: { ...previous.anthropic!, base: upstream.url },
    }
    const broker = brokerOf({ grantForToken: () => Effect.succeed(grant(["anthropic", "openai"])) })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    const port = (box.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client", "x-api-key": "client" },
        body: "{}",
      })
      expect(await response.text()).toBe("ok")
      expect(upstream.seen[0]?.headers.get("x-api-key")).toBe("real-key")
      expect(upstream.seen[0]?.headers.get("authorization")).toBeNull()
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
      upstream.server.stop(true)
      BROKER_UPSTREAMS.anthropic = previous
    }
  })

  test("an explicit OpenAI route reaches the provider's Responses endpoint", async () => {
    const upstream = capture()
    const previous = BROKER_UPSTREAMS.openrouter
    const openai = previous.openai!
    BROKER_UPSTREAMS.openrouter = {
      ...previous,
      openai: {
        chat: { ...openai.chat, base: `${upstream.url}/api/v1` },
        responses: { ...openai.responses!, base: `${upstream.url}/api/v1` },
      },
    }
    const broker = brokerOf({ grantForToken: () => Effect.succeed(grant(["openrouter"])) })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    const port = (box.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/openrouter/openai/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "native-session" },
        body: "{}",
      })
      expect(await response.text()).toBe("ok")
      expect(upstream.seen[0]?.path).toBe("/api/v1/responses")
      expect(upstream.seen[0]?.headers.get("authorization")).toBe("Bearer real-key")
      // A native session header is preserved untouched.
      expect(upstream.seen[0]?.headers.get("x-session-id")).toBe("native-session")
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
      upstream.server.stop(true)
      BROKER_UPSTREAMS.openrouter = previous
    }
  })

  test("OpenCode Go requests use the exported Go key and a stable session header", async () => {
    const upstream = capture()
    const previous = BROKER_UPSTREAMS["opencode-go"]
    const openai = previous.openai!
    BROKER_UPSTREAMS["opencode-go"] = {
      anthropic: { ...previous.anthropic!, base: `${upstream.url}/go/anthropic` },
      openai: {
        chat: { ...openai.chat, base: `${upstream.url}/go/openai/v1` },
        responses: { ...openai.responses!, base: `${upstream.url}/go/openai/v1` },
      },
    }
    let keyReads = 0
    const broker = brokerOf({
      grantForToken: () => Effect.succeed(grant(["opencode-go"], { opencodeGoKey: "go-key" })),
      upstreamKey: () => Effect.sync(() => { keyReads++; return "store-key" }),
    })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    const port = (box.address() as AddressInfo).port
    try {
      const send = (session?: string) =>
        fetch(`http://127.0.0.1:${port}/broker/token/opencode-go/openai/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(session === undefined ? {} : { "x-opencode-session": session }),
          },
          body: "{}",
        })
      expect(await (await send()).text()).toBe("ok")
      expect(await (await send("ses_fromharness")).text()).toBe("ok")
      expect(keyReads).toBe(0)
      expect(upstream.seen).toHaveLength(2)
      expect(upstream.seen[0]?.path).toBe("/go/openai/v1/responses")
      expect(upstream.seen[0]?.headers.get("authorization")).toBe("Bearer go-key")
      // The broker adds the conversation's session when the harness sends none, and preserves the harness's own.
      expect(upstream.seen[0]?.headers.get("x-opencode-session")).toBe("ses_kestrelrun")
      expect(upstream.seen[1]?.headers.get("x-opencode-session")).toBe("ses_fromharness")
      // Go expects a client that identifies itself rather than a generic HTTP library.
      expect(upstream.seen[0]?.headers.get("user-agent")).toMatch(/^kestrel\//)
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
      upstream.server.stop(true)
      BROKER_UPSTREAMS["opencode-go"] = previous
    }
  })

  test("a Codex websocket probe gets 426 instead of a stripped-upgrade request upstream", async () => {
    let keyReads = 0
    const broker = brokerOf({
      grantForToken: () => Effect.succeed(grant(["deepseek"])),
      upstreamKey: () => Effect.sync(() => { keyReads++; return "must-not-be-read" }),
    })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    try {
      const port = (box.address() as AddressInfo).port
      // `fetch` forbids the upgrade headers, so send the probe the way Codex does.
      const status = Promise.withResolvers<number>()
      const probe = request(
        {
          host: "127.0.0.1",
          port,
          path: "/broker/token/deepseek/openai/v1/responses",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        },
        (response) => {
          response.resume()
          status.resolve(response.statusCode ?? 0)
        },
      )
      probe.on("error", status.reject)
      probe.end()
      expect(await status.promise).toBe(426)
      expect(keyReads).toBe(0)
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
    }
  })

  test("a Go route without an exported key is refused instead of borrowing another provider's", async () => {
    const broker = brokerOf({
      grantForToken: () => Effect.succeed(grant(["opencode-go"])),
      upstreamKey: () => Effect.succeed(null),
    })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    try {
      const port = (box.address() as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/opencode-go/openai/v1/responses`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(424)
      expect((await response.json() as { _tag: string })._tag).toBe("MissingCredential")
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
    }
  })

  test("an API the provider does not document is refused before reading a key", async () => {
    let keyReads = 0
    const broker = brokerOf({
      grantForToken: () => Effect.succeed(grant(["anthropic", "openai"])),
      upstreamKey: () => Effect.sync(() => { keyReads++; return "must-not-be-read" }),
    })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    try {
      const port = (box.address() as AddressInfo).port
      // Anthropic documents no Responses API; the broker must not invent a translation.
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/anthropic/openai/v1/responses`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(404)
      expect((await response.json() as { _tag: string })._tag).toBe("NotFound")
      expect(keyReads).toBe(0)
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
    }
  })

  test.each([{ providers: [] }, { providers: ["openrouter"] }] as const)("rejects vendor access for a non-vendor grant %j before reading keys", async ({ providers }) => {
    let keyReads = 0
    const broker = brokerOf({
      grantForToken: () => Effect.succeed(grant(providers)),
      upstreamKey: () => Effect.sync(() => { keyReads++; return "must-not-be-read" }),
    })
    const box = createServer((req, res) => void handleBroker(broker, req, res))
    const listening = Promise.withResolvers<void>()
    box.listen(0, "127.0.0.1", listening.resolve)
    await listening.promise
    try {
      const port = (box.address() as AddressInfo).port
      const response = await fetch(`http://127.0.0.1:${port}/broker/token/anthropic/v1/messages`, {
        method: "POST",
        body: "{}",
      })
      expect(response.status).toBe(403)
      expect((await response.json() as { _tag: string })._tag).toBe("Forbidden")
      expect(keyReads).toBe(0)
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
    }
  })
})

describe("credential choice", () => {
  test("a provider key wins over the legacy flat slots", () => {
    const creds: RelayCredentials = {
      user: "octocat",
      anthropic: "old-anthropic",
      openai: "old-openai",
      providers: { anthropic: "new-anthropic", openrouter: "openrouter-key" },
    }
    expect(credentialFor(creds, "anthropic")).toBe("new-anthropic")
    expect(credentialFor(creds, "openai")).toBe("old-openai")
    expect(credentialFor(creds, "openrouter")).toBe("openrouter-key")
    // Go's key lives in OpenCode's credential store; a stray vendor slot is never used in its place.
    expect(credentialFor(creds, "opencode-go")).toBeNull()
    expect(credentialFor(null, "openai")).toBeNull()
  })
})

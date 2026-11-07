import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_MODELS, discoveredModel, type CliProvider, type ModelDiscoverySource, type ModelInfo, type RelayCredentials } from "@cloudagents/protocol"
import type { CliLoginDir } from "./cliauth"
import type { CredentialStoreShape } from "./credentials"
import { CLI_PROVIDERS } from "./agent-clis"
import {
  listAnthropicModels,
  listDeepSeekModels,
  listMiniMaxModels,
  listMoonshotModels,
  listOpenAiModels,
  listOpenRouterModels,
  makeModelDiscovery,
  type NativeModelDiscovery,
} from "./model-discovery"

const temporaryDirs: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const tempDataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-model-discovery-"))
  temporaryDirs.push(dir)
  return dir
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface FetchCall {
  readonly url: URL
  readonly headers: Record<string, string>
}

const fakeFetch = (handler: (call: FetchCall) => Response | Promise<Response>) => {
  const calls: FetchCall[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const call = { url, headers }
    calls.push(call)
    return handler(call)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

const credentialStore = (initial: Readonly<Record<string, RelayCredentials>>) => {
  const byUser = new Map(Object.entries(initial))
  const shape: CredentialStoreShape = {
    get: (user) => Effect.succeed(byUser.get(user) ?? null),
    set: (credentials) => Effect.sync(() => void byUser.set(credentials.user, credentials)),
  }
  return { shape, byUser }
}

const loginDir = async (dataDir: string, user: string, dir: string): Promise<void> => {
  await mkdir(join(dataDir, "users", user, dir), { recursive: true })
}

const nativeFor = (options: {
  readonly logins?: () => ReadonlyArray<CliLoginDir>
  readonly models?: ReadonlyArray<ModelInfo>
  readonly sources?: ReadonlyArray<ModelDiscoverySource>
  readonly onDiscover?: () => void
  readonly onLoginProbe?: () => void
  readonly statusErrors?: ReadonlyArray<CliProvider>
  /** CLIs the box cannot run at all; the real status also carries an error, as a missing binary does. */
  readonly cannotSignIn?: ReadonlyArray<CliProvider>
}): NativeModelDiscovery => ({
  status: () => Effect.sync(() => {
    options.onLoginProbe?.()
    const logins = options.logins?.() ?? []
    return CLI_PROVIDERS.map((provider) => ({
      provider, loggedIn: logins.some((login) => login.provider === provider), account: null,
      ...(options.cannotSignIn?.includes(provider)
        ? { error: `${provider} is not installed on the box`, cannotSignIn: true }
        : options.statusErrors?.includes(provider) ? { error: "CLI probe unavailable" } : {}),
    }))
  }),
  discoverModels: () => Effect.sync(() => {
    options.onDiscover?.()
    return { models: options.models ?? [], sources: options.sources ?? [] }
  }),
})

const idSet = (models: ReadonlyArray<ModelInfo>): ReadonlyArray<string> => models.map((model) => model.id)

test("Anthropic pagination follows the cursor and drops retired models", async () => {
  const { fetch, calls } = fakeFetch(({ url }) => {
    if (url.searchParams.get("after_id") === null) {
      return json({
        data: [
          { id: "claude-opus-5-5", lifecycle: "active" },
          { id: "claude-old", lifecycle: "retired" },
        ],
        has_more: true,
        last_id: "cursor-1",
      })
    }
    return json({ data: [{ id: "claude-sonnet-5-5", lifecycle: "active" }], has_more: false, last_id: "cursor-2" })
  })

  const models = await Effect.runPromise(listAnthropicModels("key", fetch))
  expect(idSet(models)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"])
  expect(calls).toHaveLength(2)
  expect(calls[1]?.url.searchParams.get("after_id")).toBe("cursor-1")
  // Curated ids keep their curated metadata rather than becoming live entries.
  expect(models[0]?.upstreamModel).toBeUndefined()
})

test("OpenAI discovery keeps only Codex-runnable text families", async () => {
  const ids = [
    "gpt-5.1-codex",
    "gpt-6.1-sol",
    "o3",
    "o10-mini",
    "codex-mini-latest",
    "o1-preview",
    "o1-mini",
    "gpt-5.1-chat-latest",
    "gpt-4.1",
    "gpt-3.5-turbo",
    "text-embedding-3-large",
    "gpt-image-1",
    "gpt-4o-audio-preview",
    "chatgpt-4o-latest",
    "ft:gpt-5:org::custom",
  ]
  const { fetch } = fakeFetch(() => json({ data: ids.map((id) => ({ id })) }))

  const models = await Effect.runPromise(listOpenAiModels("key", fetch))
  expect(idSet(models)).toEqual([
    "live/openai/gpt-5.1-codex",
    "gpt-6.1-sol",
    "live/openai/o3",
    "live/openai/o10-mini",
    "live/openai/codex-mini-latest",
  ])
  expect(models.map((model) => model.id)).toContain("live/openai/gpt-5.1-codex")
  expect(models[2]?.name).toBe("o3")
})

test("OpenRouter discovery stays on Anthropic ids with declared tool/text support", async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({
    id: `openai/filler-${index}`,
    supported_parameters: ["tools"],
    architecture: { output_modalities: ["text"] },
  }))
  const { fetch, calls } = fakeFetch(({ url }) => {
    if (url.searchParams.get("offset") === "0") return json({ data: first })
    return json({
      data: [
        { id: "anthropic/claude-opus-5.5", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
        { id: "anthropic/claude-opus-5.5:batch", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
        { id: "anthropic/claude-opus-5.5:free:batch", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
        { id: "anthropic/claude-opus-5.5:free", supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
        { id: "anthropic/claude-haiku-5.5" },
        { id: "anthropic/claude-sonnet-5.5", supported_parameters: [] },
        { id: "openai/gpt-5.1", supported_parameters: ["tools"] },
        { id: "anthropic/claude-image-1", supported_parameters: ["tools"] },
      ],
    })
  })

  const models = await Effect.runPromise(listOpenRouterModels("key", fetch))
  expect(idSet(models)).toEqual([
    "anthropic/claude-opus-5.5",
    "live/openrouter/anthropic/claude-opus-5.5:free",
    "anthropic/claude-haiku-5.5",
  ])
  expect(calls.map((call) => call.url.searchParams.get("offset"))).toEqual(["0", "1000"])
})

test("DeepSeek drops a model whose Anthropic Messages capability is false", async () => {
  const { fetch } = fakeFetch(() => json({
    data: [
      { id: "deepseek-flash", api_capabilities: { anthropic_messages: { supported: true } } },
      { id: "deepseek-chat-only", api_capabilities: { anthropic_messages: false } },
      { id: "deepseek-reasoner" },
    ],
  }))

  const models = await Effect.runPromise(listDeepSeekModels("key", fetch))
  expect(idSet(models)).toEqual(["deepseek-flash[1m]", "live/deepseek/deepseek-reasoner"])
})

test("MiniMax lists chat models, not its video/speech/music families", async () => {
  const { fetch } = fakeFetch(() => json({
    data: [
      { id: "MiniMax-M9.1-Flash" },
      { id: "MiniMax-M9" },
      { id: "MiniMax-Hailuo-2.3" },
      { id: "MiniMax-Speech-02" },
      { id: "MiniMax-Music-01" },
      { id: "MiniMax-embedding-1" },
    ],
  }))

  const models = await Effect.runPromise(listMiniMaxModels("key", fetch))
  expect(idSet(models)).toEqual(["live/minimax/MiniMax-M9.1-Flash", "live/minimax/MiniMax-M9"])
})

test("Moonshot lists chat models, not its embedding/audio families", async () => {
  const { fetch } = fakeFetch(() => json({
    data: [
      { id: "kimi-k3.1-pro" },
      { id: "moonshot-v1-32k" },
      { id: "moonshot-v1-8k-vision-preview" },
      { id: "moonshot-v1-embedding" },
      { id: "moonshot-v1-audio-preview" },
    ],
  }))

  const models = await Effect.runPromise(listMoonshotModels("key", fetch))
  expect(idSet(models)).toEqual([
    "kimi-k3.1-pro",
    "live/moonshot/moonshot-v1-32k",
    "live/moonshot/moonshot-v1-8k-vision-preview",
  ])
})

test("catalogs are owner-scoped, cached, and refreshed explicitly", async () => {
  const dataDir = await tempDataDir()
  const credentials = credentialStore({
    alice: { user: "alice", providers: { deepseek: "alpha-key" } },
    bob: { user: "bob", providers: { deepseek: "beta-key" } },
  })
  const { fetch, calls } = fakeFetch(({ headers }) => {
    const key = headers.authorization ?? ""
    return json({ data: [{ id: key.includes("alpha") ? "deepseek-alpha" : key.includes("gamma") ? "deepseek-gamma" : "deepseek-beta" }] })
  })
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native: nativeFor({}), dataDir, fetch }))

  const alice = await Effect.runPromise(discovery.get("alice"))
  const bob = await Effect.runPromise(discovery.get("bob"))
  expect(idSet(alice.models)).toContain("live/deepseek/deepseek-alpha")
  expect(idSet(bob.models)).toContain("live/deepseek/deepseek-beta")
  expect(idSet(alice.models)).not.toContain("live/deepseek/deepseek-beta")
  expect(calls).toHaveLength(2)

  await Effect.runPromise(discovery.get("alice"))
  expect(calls).toHaveLength(2)

  await Effect.runPromise(discovery.get("alice", { refresh: true }))
  expect(calls).toHaveLength(3)

  credentials.byUser.set("alice", { user: "alice", providers: { deepseek: "gamma-key" } })
  const changed = await Effect.runPromise(discovery.get("alice"))
  expect(idSet(changed.models)).toContain("live/deepseek/deepseek-gamma")
  expect(calls).toHaveLength(4)
})

test("concurrent requests share one discovery load", async () => {
  const dataDir = await tempDataDir()
  const credentials = credentialStore({ alice: { user: "alice", providers: { deepseek: "alpha-key" } } })
  const { promise: gate, resolve: release } = Promise.withResolvers<void>()
  let calls = 0
  // Discovery uses fetch's callable API, not Bun's attached preconnect helper.
  const fetch = (async () => {
    calls++
    await gate
    return json({ data: [{ id: "deepseek-alpha" }] })
  }) as unknown as typeof globalThis.fetch
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native: nativeFor({}), dataDir, fetch }))

  const first = Effect.runPromise(discovery.get("alice"))
  const second = Effect.runPromise(discovery.get("alice"))
  await Promise.resolve()
  release()
  const [left, right] = await Promise.all([first, second])
  expect(idSet(left.models)).toContain("live/deepseek/deepseek-alpha")
  expect(idSet(right.models)).toEqual(idSet(left.models))
  expect(calls).toBe(1)
})

test("a failing API source is a safe status entry, not a failed catalog", async () => {
  const dataDir = await tempDataDir()
  const credentials = credentialStore({ alice: { user: "alice", providers: { deepseek: "secret-key" } } })
  // Discovery uses fetch's callable API, not Bun's attached preconnect helper.
  const fetch = (async () =>
    new Response(JSON.stringify({ error: "upstream secret-key is invalid" }), { status: 401 })) as unknown as typeof globalThis.fetch
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native: nativeFor({}), dataDir, fetch }))

  const catalog = await Effect.runPromise(discovery.get("alice"))
  expect(idSet(catalog.models)).toEqual(idSet(AGENT_MODELS))
  const deepseek = catalog.sources.find((source) => source.provider === "deepseek")
  expect(deepseek?.status).toBe("error")
  expect(deepseek?.message).toContain("HTTP 401")
  expect(catalog.sources.filter((source) => source.status === "unsupported")).toHaveLength(12)
  expect(catalog.sources).toHaveLength(13)
  expect(JSON.stringify(catalog.sources)).not.toContain("secret-key")
})

test("a native subscription login suppresses API models and contributes native ids", async () => {
  const dataDir = await tempDataDir()
  await loginDir(dataDir, "alice", "claude")
  const credentials = credentialStore({ alice: { user: "alice", providers: { anthropic: "api-key" } } })
  let anthropicCalls = 0
  const { fetch } = fakeFetch(({ url }) => {
    if (url.hostname === "api.anthropic.com") anthropicCalls++
    return json({ data: [{ id: "claude-api-only" }] })
  })
  const nativeModels = [discoveredModel("anthropic", "claude-new-9")!]
  const native = nativeFor({
    logins: () => [{ provider: "claude-cli", dir: join(dataDir, "users", "alice", "claude") }],
    models: nativeModels,
    sources: [{ provider: "anthropic", source: "claude-cli", status: "ok", checkedAt: new Date().toISOString() }],
  })
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native, dataDir, fetch }))

  const catalog = await Effect.runPromise(discovery.get("alice"))
  expect(anthropicCalls).toBe(0)
  expect(idSet(catalog.models)).toContain("live/anthropic/claude-new-9")
  expect(idSet(catalog.models)).not.toContain("live/anthropic/claude-api-only")
  const apiSource = catalog.sources.find((source) => source.provider === "anthropic" && source.source === "Anthropic API")
  expect(apiSource?.status).toBe("unsupported")
  expect(apiSource?.message).toContain("Claude Code subscription login takes precedence")
})

test("a login appearing after a cached load invalidates the native login fingerprint", async () => {
  const dataDir = await tempDataDir()
  const credentials = credentialStore({ alice: { user: "alice" } })
  const { fetch } = fakeFetch(() => json({ data: [] }))
  let probes = 0
  const native = nativeFor({
    logins: () => [{ provider: "claude-cli", dir: join(dataDir, "users", "alice", "claude") }],
    onLoginProbe: () => { probes++ },
  })
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native, dataDir, fetch }))

  await Effect.runPromise(discovery.get("alice"))
  expect(probes).toBe(0)

  await loginDir(dataDir, "alice", "claude")
  await Effect.runPromise(discovery.get("alice"))
  expect(probes).toBe(1)
})

test("an in-place native credential replacement invalidates the cache", async () => {
  const dataDir = await tempDataDir()
  const login = join(dataDir, "users", "alice", "claude")
  await mkdir(login, { recursive: true })
  await writeFile(join(login, ".credentials.json"), "first-account")
  const credentials = credentialStore({ alice: { user: "alice" } })
  const { fetch } = fakeFetch(() => json({ data: [] }))
  let probes = 0
  let account = 0
  const native: NativeModelDiscovery = {
    status: () => Effect.sync(() => {
      probes++
      return CLI_PROVIDERS.map((provider) => ({ provider, loggedIn: provider === "claude-cli", account: null }))
    }),
    discoverModels: () => Effect.sync(() => ({
      models: [discoveredModel("anthropic", account === 0 ? "claude-account-a" : "claude-account-b")!],
      sources: [],
    })),
  }
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native, dataDir, fetch }))

  const first = await Effect.runPromise(discovery.get("alice"))
  expect(idSet(first.models)).toContain("live/anthropic/claude-account-a")
  expect(probes).toBe(1)

  // Rewrite the existing credential file in place: the login directory's own mtime may not change.
  account = 1
  await writeFile(join(login, ".credentials.json"), "second-account-with-a-different-size")
  const second = await Effect.runPromise(discovery.get("alice"))
  expect(probes).toBe(2)
  expect(idSet(second.models)).toContain("live/anthropic/claude-account-b")
  expect(idSet(second.models)).not.toContain("live/anthropic/claude-account-a")
})

test("no credentials still reports every source as not connected or signed out", async () => {
  const dataDir = await tempDataDir()
  const credentials = credentialStore({ alice: { user: "alice" } })
  const { fetch, calls } = fakeFetch(() => json({ data: [] }))
  const discovery = await Effect.runPromise(makeModelDiscovery({ credentials: credentials.shape, native: nativeFor({}), dataDir, fetch }))

  const catalog = await Effect.runPromise(discovery.get("alice"))
  expect(idSet(catalog.models)).toEqual(idSet(AGENT_MODELS))
  expect(catalog.sources).toHaveLength(13)
  expect(catalog.sources.every((source) => source.status === "unsupported")).toBe(true)
  expect(catalog.sources.every((source) =>
    source.message === "not connected" || source.message === "not signed in" ||
    source.message?.includes("is not connected on this box") === true
  )).toBe(true)
  expect(calls).toEqual([])
})

test("a failed native status suppresses only that vendor's API-only models", async () => {
  const dataDir = await tempDataDir()
  await loginDir(dataDir, "alice", "codex")
  const credentials = credentialStore({
    alice: { user: "alice", providers: { anthropic: "api-key", openai: "api-key" } },
  })
  const { fetch } = fakeFetch(() => json({ data: [{ id: "claude-future" }], has_more: false }))
  const discovery = await Effect.runPromise(makeModelDiscovery({
    credentials: credentials.shape, dataDir, fetch,
    native: nativeFor({ statusErrors: ["codex-cli"] }),
  }))
  const catalog = await Effect.runPromise(discovery.get("alice"))
  expect(idSet(catalog.models)).toContain("live/anthropic/claude-future")
  expect(catalog.sources.find((source) => source.source === "OpenAI API")?.status).toBe("error")
  expect(catalog.sources.find((source) => source.source === "Anthropic API")?.status).toBe("ok")
})

test("a CLI that cannot sign in keeps its vendor's API models and is reported as absent", async () => {
  const dataDir = await tempDataDir()
  await loginDir(dataDir, "alice", "codex")
  const credentials = credentialStore({ alice: { user: "alice", providers: { openai: "api-key" } } })
  const { fetch, calls } = fakeFetch(() => json({ data: [{ id: "gpt-9" }] }))
  const discovery = await Effect.runPromise(makeModelDiscovery({
    credentials: credentials.shape, dataDir, fetch,
    native: nativeFor({ cannotSignIn: ["codex-cli"] }),
  }))

  const catalog = await Effect.runPromise(discovery.get("alice"))
  // A missing CLI rules out a subscription, so it must not stand in front of the user's API key.
  expect(idSet(catalog.models)).toContain("live/openai/gpt-9")
  expect(catalog.sources.find((source) => source.source === "OpenAI API")?.status).toBe("ok")
  expect(catalog.sources.find((source) => source.source === "codex-cli")?.message)
    .toBe("the CLI is not installed or cannot sign in")
  // Nothing was uncertain, so the answer is not the short degraded cache.
  await Effect.runPromise(discovery.get("alice"))
  expect(calls).toHaveLength(1)
})

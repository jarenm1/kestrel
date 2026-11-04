import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { MODEL_PROVIDERS, providerModels, type RelayCredentials } from "@cloudagents/protocol"
import { BROKER_PROVIDERS, BROKER_UPSTREAMS, brokerEnv, credentialFor, type CredentialBrokerShape } from "./index"
import { handleBroker } from "./handler"

const BASE = "http://127.0.0.1:8787/broker/run-token"

describe("broker provider mapping", () => {
  test("every brokered provider has an upstream and every model provider has a model", () => {
    expect(BROKER_PROVIDERS).toEqual(["anthropic", "openai"])
    for (const provider of BROKER_PROVIDERS) {
      expect(BROKER_UPSTREAMS[provider].base).toMatch(/^https:\/\//)
    }
    for (const provider of MODEL_PROVIDERS) {
      expect(providerModels(provider.id).length).toBeGreaterThan(0)
    }
  })

  test("Anthropic keeps its API key env; OpenAI keeps its base URL", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      expect(brokerEnv(provider, BASE, "t")).toEqual({
        ANTHROPIC_BASE_URL: `${BASE}/anthropic`,
        ANTHROPIC_API_KEY: "t",
        OPENAI_BASE_URL: `${BASE}/openai/v1`,
        OPENAI_API_KEY: "t",
      })
    }
  })

  test("Anthropic requests inject the key in x-api-key", async () => {
    const seen: Headers[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers)
        return new Response("ok")
      },
    })
    const previous = BROKER_UPSTREAMS.anthropic
    BROKER_UPSTREAMS.anthropic = { ...previous, base: `http://127.0.0.1:${upstream.port}` }
    const broker: CredentialBrokerShape = {
      issue: () => Effect.die("unused"),
      revoke: () => Effect.void,
      grantForToken: () => Effect.succeed({ runId: "run", user: "octocat", providers: ["anthropic"] }),
      onRevoke: () => () => undefined,
      upstreamKey: () => Effect.succeed("real-key"),
    }
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
      expect(seen[0]?.get("x-api-key")).toBe("real-key")
      expect(seen[0]?.get("authorization")).toBeNull()
    } finally {
      const closed = Promise.withResolvers<void>()
      box.close(() => closed.resolve())
      await closed.promise
      upstream.stop(true)
      BROKER_UPSTREAMS.anthropic = previous
    }
  })

  test("credentialFor reads the flat slots", () => {
    const creds: RelayCredentials = { user: "octocat", anthropic: "old-anthropic", openai: "old-openai" }
    expect(credentialFor(creds, "anthropic")).toBe("old-anthropic")
    expect(credentialFor(creds, "openai")).toBe("old-openai")
    expect(credentialFor(null, "openai")).toBeNull()
  })
})

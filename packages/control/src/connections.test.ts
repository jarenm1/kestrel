import { expect, mock, test } from "bun:test"
import { Schema } from "effect"
import {
  Connection,
  CliProvider,
  ControlPaths,
  connectedModelProviders,
  connectionsForBox,
  resolveModelRoute,
} from "@cloudagents/protocol"
import type { Env } from "./env"

// Bun has no cloudflare:workers runtime; install that platform mock before loading the real Worker.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default

const connections = async (offline = false): Promise<readonly Connection[]> => {
  const stub = {
    session: async (id: string) => id === "signed-in" ? { login: "tester" } : null,
    connections: async () => offline ? [{ provider: "anthropic", account: "saved-key" }] : [],
    connectionSecret: async () => null,
    boxCall: async (_login: string, _method: string, path: string) => {
      if (offline) return { ok: false, status: 503, body: "box offline" }
      if (path === ControlPaths.cliAuthFor(CliProvider.literals)) return {
        ok: true, status: 200,
        body: JSON.stringify([
          { provider: "claude-cli", loggedIn: true, account: "Claude subscription" },
          { provider: "codex-cli", loggedIn: true, account: "ChatGPT subscription" },
        ]),
      }
      if (path === ControlPaths.harnessStatus) return {
        ok: true, status: 200,
        body: JSON.stringify([
          { harness: "opencode", available: true },
          { harness: "omp", available: true },
          { harness: "pi", available: false, error: "adapter missing" },
        ]),
      }
      throw new Error(`unexpected box path ${path}`)
    },
  }
  const env = { HUB: { idFromName: () => "main", get: () => stub } } as unknown as Env
  const response = await worker.fetch(new Request(`https://app.example${ControlPaths.connections}`, {
    headers: { cookie: "session=signed-in" },
  }), env)
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Schema.Array(Connection))(await response.json())
}

test("installed clients retain CLI subscriptions and standalone models without a selected-box merge", async () => {
  const rows = await connections()
  // Installed clients consume this response directly, without connectionsForBox.
  expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual([
    "anthropic", "openai", "opencode", "omp",
  ])
  expect(rows.find((row) => row.provider === "claude-cli")).toMatchObject({
    connected: true, available: true, account: "Claude subscription",
  })
  expect(rows.find((row) => row.provider === "codex-cli")).toMatchObject({
    connected: true, available: true, account: "ChatGPT subscription",
  })
  expect(rows.find((row) => row.provider === "pi")).toMatchObject({
    connected: false, available: false, error: "adapter missing",
  })
})

test("updated clients replace legacy box state with their selected box's Go login and capabilities", async () => {
  const selected = connectionsForBox(await connections(), {
    cliAuth: [{ provider: "opencode-go", loggedIn: true, account: null }],
    harnesses: ["opencode", "opencode-go"],
  })
  expect(connectedModelProviders(selected).map((provider) => provider.id)).toEqual(["opencode", "opencode-go"])
  const route = resolveModelRoute({ harnessId: "opencode", modelId: "opencode-go/glm-5.3", connections: selected })
  expect(route.ok && route.route.provider).toBe("opencode-go")
  expect(selected.find((row) => row.provider === "claude-cli")?.connected).toBe(false)
  expect(selected.find((row) => row.provider === "omp")?.available).toBe(false)
})

test("an offline legacy box does not hide stored API keys or claim a CLI is connected", async () => {
  const rows = await connections(true)
  expect(connectedModelProviders(rows).map((provider) => provider.id)).toEqual(["anthropic"])
  expect(rows.find((row) => row.provider === "anthropic")).toMatchObject({ connected: true, available: true, account: "saved-key" })
  expect(rows.filter((row) => row.kind === "cli").every((row) => !row.connected && !row.available)).toBe(true)
})

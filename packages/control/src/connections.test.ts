import { expect, mock, test } from "bun:test"
import { Schema } from "effect"
import {
  Connection,
  CliProvider,
  ControlPaths,
  Paths,
  connectedModelProviders,
  connectionsForBox,
} from "@cloudagents/protocol"
import type { Env } from "./env"

// Bun has no cloudflare:workers runtime; install that platform mock before loading the real Worker.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default

/** What the box reports when it has the free OpenCode CLI; its other harnesses do not need a row. */
const HARNESSES = ["anthropic", "openai", "opencode"] as const

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
      if (path === Paths.capabilities) return {
        ok: true, status: 200,
        body: JSON.stringify({
          version: 1, platform: "linux", sandbox: "off", desktop: "unavailable", harnesses: HARNESSES,
        }),
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

test("installed clients retain CLI subscriptions and the box's free OpenCode row", async () => {
  const rows = await connections()
  // Installed clients consume this response directly, without connectionsForBox.
  expect(connectedModelProviders(rows, HARNESSES).map((provider) => provider.id)).toEqual([
    "anthropic", "openai", "opencode",
  ])
  expect(rows.find((row) => row.provider === "claude-cli")).toMatchObject({
    connected: true, available: true, account: "Claude subscription",
  })
  expect(rows.find((row) => row.provider === "codex-cli")).toMatchObject({
    connected: true, available: true, account: "ChatGPT subscription",
  })
  // Free OpenCode has no connection of its own: the box's capabilities said it can launch it.
  expect(rows.find((row) => row.provider === "opencode")).toMatchObject({
    kind: "cli", connected: true, available: true, account: null,
  })
  // Go is a CLI login, reported by the box's cli-auth like the other subscriptions; this box has no Go key.
  expect(rows.find((row) => row.provider === "opencode-go")).toMatchObject({ kind: "cli", connected: false, available: false })
})

test("updated clients replace legacy box state with their selected box's Go login and harnesses", async () => {
  const relay: readonly Connection[] = [
    { provider: "anthropic", label: "Anthropic", kind: "apikey", connected: true, account: "saved-key", available: true },
    { provider: "opencode-go", label: "OpenCode Go", kind: "cli", connected: false, account: null, available: false, error: "not installed on the managed box" },
  ]
  const selected = connectionsForBox(relay, {
    cliAuth: [{ provider: "opencode-go", loggedIn: true, account: null }],
    harnesses: ["opencode"],
  })
  expect(connectedModelProviders(selected, ["opencode"]).map((provider) => provider.id)).toEqual(["anthropic", "opencode", "opencode-go"])
  expect(selected.find((row) => row.provider === "opencode-go")).toMatchObject({ connected: true, available: true })
  expect(selected.find((row) => row.provider === "opencode-go")?.error).toBeUndefined()
  expect(selected.find((row) => row.provider === "opencode")).toMatchObject({ connected: true, available: true })
  expect(selected.find((row) => row.provider === "anthropic")).toEqual(relay[0]!)
})

test("retired standalone harness rows never reach the selected box's connections", () => {
  const relay: readonly Connection[] = [
    { provider: "omp", label: "OMP", kind: "cli", connected: true, account: null, available: true },
    { provider: "pi", label: "Pi", kind: "cli", connected: true, account: null, available: true },
    { provider: "hermes", label: "Hermes", kind: "cli", connected: true, account: null, available: true },
  ]
  const selected = connectionsForBox(relay, { cliAuth: [], harnesses: [] })
  expect(selected.map((row) => row.provider)).toEqual(["opencode"])
  expect(selected[0]).toMatchObject({ connected: false, available: false })
})

test("an offline legacy box does not hide stored API keys or claim a CLI is connected", async () => {
  const rows = await connections(true)
  // The box could not answer, so it reports no harness and no free OpenCode row is invented.
  expect(connectedModelProviders(rows, []).map((provider) => provider.id)).toEqual(["anthropic"])
  expect(rows.find((row) => row.provider === "anthropic")).toMatchObject({ connected: true, available: true, account: "saved-key" })
  expect(rows.filter((row) => row.kind === "cli").every((row) => !row.connected && !row.available)).toBe(true)
  expect(rows.some((row) => row.provider === "opencode")).toBe(false)
})

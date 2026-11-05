import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  BOX_USER_HEADER,
  CliAuthStatus,
  CliProvider,
  ControlPaths,
  ProviderUsage,
} from "@cloudagents/protocol"
import { makeWebHandler } from "./router"

// Installed clients compiled before Go accept exactly these provider literals.
const installedProvider = Schema.Literal("claude-cli", "codex-cli", "antigravity-cli")
const installedStatus = Schema.Array(Schema.Struct({ ...CliAuthStatus.fields, provider: installedProvider }))
const installedUsage = Schema.Array(Schema.Struct({ ...ProviderUsage.fields, provider: installedProvider }))

const handler = async (goConnected: boolean) => {
  const status: readonly CliAuthStatus[] = [
    { provider: "claude-cli", loggedIn: true, account: "Claude subscription" },
    { provider: "codex-cli", loggedIn: true, account: "ChatGPT subscription" },
    { provider: "antigravity-cli", loggedIn: false, account: null },
    { provider: "opencode", loggedIn: true, account: null },
    { provider: "opencode-go", loggedIn: goConnected, account: null },
  ]
  const usage: readonly ProviderUsage[] = [
    { provider: "claude-cli", status: "ok", plan: "Pro", windows: [{ id: "five-hour", label: "5 hours", usedPercent: 12, resetsAt: null }] },
    { provider: "codex-cli", status: "ok", plan: "Plus", windows: [{ id: "weekly", label: "Weekly", usedPercent: 35, resetsAt: null }] },
    { provider: "opencode-go", status: goConnected ? "ok" : "signed_out", plan: goConnected ? "Go" : null, windows: goConnected ? [{ id: "five-hour", label: "5 hours", usedPercent: 41, resetsAt: null }] : [] },
  ]
  return Effect.runPromise(makeWebHandler({} as never, {
    status: () => Effect.succeed(status),
    providerUsage: () => Effect.succeed(usage),
  } as never, { version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable" }))
}

const request = (path: string) => new Request(`http://box.test${path}`, { headers: { [BOX_USER_HEADER]: "tester" } })

test("installed status and usage decoders retain native subscriptions when Go is unconfigured", async () => {
  const serve = await handler(false)
  const status = await serve(request(ControlPaths.cliAuth))
  expect(status.status).toBe(200)
  const statuses = Schema.decodeUnknownSync(installedStatus)(await status.json())
  expect(statuses.map((row) => row.provider)).toEqual(["claude-cli", "codex-cli", "antigravity-cli"])
  expect(statuses.find((row) => row.provider === "codex-cli")?.loggedIn).toBe(true)

  const usage = await serve(request(ControlPaths.cliUsage))
  expect(usage.status).toBe(200)
  const windows = Schema.decodeUnknownSync(installedUsage)(await usage.json())
  expect(windows.map((row) => row.provider)).toEqual(["claude-cli", "codex-cli"])
  expect(windows.find((row) => row.provider === "codex-cli")?.windows[0]?.usedPercent).toBe(35)
})

test("Go-aware clients explicitly request their provider catalog and retain Go quotas", async () => {
  const serve = await handler(true)
  const query = `?providers=${encodeURIComponent(CliProvider.literals.join(","))}`
  const statuses = Schema.decodeUnknownSync(Schema.Array(CliAuthStatus))(await (await serve(request(ControlPaths.cliAuth + query))).json())
  expect(statuses.find((row) => row.provider === "opencode-go")?.loggedIn).toBe(true)
  expect(statuses.find((row) => row.provider === "opencode")?.loggedIn).toBe(true)
  expect(statuses.find((row) => row.provider === "claude-cli")?.loggedIn).toBe(true)
  const usage = Schema.decodeUnknownSync(Schema.Array(ProviderUsage))(await (await serve(request(ControlPaths.cliUsage + query))).json())
  expect(usage.find((row) => row.provider === "opencode-go")?.windows[0]?.usedPercent).toBe(41)
  expect(usage.find((row) => row.provider === "codex-cli")?.windows[0]?.usedPercent).toBe(35)
})

test("a narrower installed catalog never receives a configured provider it did not advertise", async () => {
  const serve = await handler(true)
  for (const path of [ControlPaths.cliAuth, ControlPaths.cliUsage]) {
    const response = await serve(request(`${path}?providers=codex-cli`))
    expect(response.status).toBe(200)
    const rows = await response.json() as Array<{ provider: string }>
    expect(rows.map((row) => row.provider)).toEqual(["codex-cli"])
  }
})

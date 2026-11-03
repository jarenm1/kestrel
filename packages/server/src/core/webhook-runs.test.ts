import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { BOX_USER_HEADER, InternalError } from "@cloudagents/protocol"
import { Config, type ServerConfig } from "../config"
import { DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { CliAuth } from "../cliauth"
import { GitHub } from "../github/api"
import { AgentHarness, type AgentChoice } from "./harness"
import { EventHubLive } from "./events"
import { CoreLive, CoreService } from "./service"
import { StateLive } from "./state"
import { WorkspaceService } from "./workspace"
import { makeWebHandler } from "../http/router"

test("webhook runs are recorded before they are answered, deduplicated by delivery, and a launch failure ends as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kestrel-webhook-runs-"))
  const config: ServerConfig = {
    port: 8899, host: "127.0.0.1", sandboxPort: 8899, mcpBaseUrl: "http://127.0.0.1:8899", dataDir: root,
    stateFile: join(root, "state.json"), mirrorsDir: join(root, "mirrors"), threadsDir: join(root, "threads"),
    shadowsDir: join(root, "shadows"), runsDir: join(root, "runs"), attachmentsDir: join(root, "attachments"), homesDir: join(root, "homes"),
    agentCommands: { anthropic: "", openai: "" }, fakeAgent: false, fakeAgentRoBinds: [], sandbox: "off", sandboxPath: null,
    sandboxSslCertFile: null, systemd: null, maxConcurrentRuns: 2, relay: null, direct: null, toolkitsFlake: null,
    taskDiskMax: 1024 ** 3, desktopBundleMs: 0, githubApiUrl: "https://api.github.com",
  }
  const choices: AgentChoice[] = []
  let failSpawn = false
  const configLayer = Layer.succeed(Config, config)
  const workspaceLayer = Layer.succeed(WorkspaceService, {} as never)
  const deps = Layer.mergeAll(
    configLayer, StateLive.pipe(Layer.provide(Layer.merge(configLayer, workspaceLayer))), EventHubLive,
    Layer.succeed(DesktopManager, { watchStatus: () => Effect.void, status: () => Effect.succeed({ state: "stopped", display: null }), stopAll: () => Effect.void } as never),
    workspaceLayer, Layer.succeed(CredentialStore, {} as never),
    Layer.succeed(GitHub, {} as never), Layer.succeed(CliAuth, {} as never),
    Layer.succeed(AgentHarness, {
      spawn: (_task: unknown, _run: unknown, _prompt: unknown, _display: unknown, _user: unknown, _session: unknown, choice: AgentChoice) =>
        failSpawn ? Effect.fail(new InternalError({ message: "spawn refused" })) : Effect.sync(() => { choices.push(choice) }),
      steer: () => Effect.succeed(false), cancel: () => Effect.void, stopAll: () => Effect.void, items: () => Effect.succeed([]), itemCount: () => 0,
    } as never),
  )
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const core = yield* CoreService
      const handler = yield* makeWebHandler(core, {} as never, { version: 1, platform: "other", sandbox: "off", desktop: "unavailable" })
      const send = (body: unknown, user: string | null = "owner") =>
        Effect.promise(() => handler(new Request("http://localhost/api/webhook-runs", {
          method: "POST",
          headers: { "content-type": "application/json", ...(user === null ? {} : { [BOX_USER_HEADER]: user }) },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })))
      const lookup = (deliveryId: string, user: string) =>
        Effect.promise(() => handler(new Request(`http://localhost/api/webhook-runs/${deliveryId}`, { headers: { [BOX_USER_HEADER]: user } })))
      const request = { deliveryId: "delivery-1", automationId: "auto-1", title: "Nightly sync", prompt: "Sync the docs" }

      // Callers without an owner identity are refused (400, as on every signed-in route) before anything is stored.
      expect((yield* send(request, null)).status).toBe(400)

      // A new delivery is recorded and its run starts: 201.
      const created = yield* send(request)
      expect(created.status).toBe(201)
      const first = yield* Effect.promise(() => created.json())
      expect(first).toMatchObject({ deliveryId: "delivery-1" })
      expect(first.taskId).toBeTruthy()
      expect(choices).toHaveLength(1)

      // The same body again is a redelivery: 200 with the same answer, and no second run.
      const repeat = yield* send(request)
      expect(repeat.status).toBe(200)
      expect(yield* Effect.promise(() => repeat.json())).toEqual(first)
      expect(choices).toHaveLength(1)

      // The same delivery id with a different body is a conflict, not a second run.
      expect((yield* send({ ...request, prompt: "Something else" })).status).toBe(409)
      expect(choices).toHaveLength(1)

      // Invalid bodies are refused definitively: 400 for bad JSON, bad fields, and an oversized body.
      expect((yield* send(request.prompt)).status).toBe(400)
      expect((yield* send({ ...request, prompt: "" })).status).toBe(400)
      expect((yield* send({ ...request, deliveryId: "delivery-big", prompt: "x".repeat(1024 * 1024 + 1) })).status).toBe(400)

      // Status is visible to the owner only; an unknown delivery is 404.
      expect((yield* lookup("delivery-1", "owner")).status).toBe(200)
      expect((yield* lookup("delivery-1", "other")).status).toBe(404)
      expect((yield* lookup("delivery-never", "owner")).status).toBe(404)

      // The record is in the state file, so a restart still knows the delivery.
      const disk = yield* Effect.promise(() => readFile(config.stateFile, "utf8"))
      expect(disk).toContain('"deliveryId":"delivery-1"')

      // A launch failure after acceptance ends the run as failed. The delivery stays recorded: a redelivery
      // gets that answer and starts nothing.
      failSpawn = true
      const failed = yield* send({ ...request, deliveryId: "delivery-2", prompt: "Will fail" })
      expect(failed.status).toBe(201)
      expect((yield* Effect.promise(() => failed.json())).status).toBe("failed")
      failSpawn = false
      const again = yield* send({ ...request, deliveryId: "delivery-2", prompt: "Will fail" })
      expect(again.status).toBe(200)
      expect((yield* Effect.promise(() => again.json())).status).toBe("failed")
      expect(choices).toHaveLength(1)
    }).pipe(Effect.provide(CoreLive.pipe(Layer.provide(deps), Layer.provideMerge(deps)))))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

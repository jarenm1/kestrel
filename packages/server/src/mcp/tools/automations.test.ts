import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { type ControlClient, ControlError } from "../../control/client"
import { registerAutomationTools } from "./automations"

/** What each fake control call does; the harness records the call itself, in order with the registry writes. */
interface FakeControl {
  readonly watchPr?: () => Effect.Effect<void, ControlError>
  readonly unwatchPr?: () => Effect.Effect<void, ControlError>
}

const fakeControl = (calls: string[], fake: FakeControl): ControlClient => ({
  watchPr: (_user, _taskId, repo, number) =>
    Effect.suspend(() => {
      calls.push(`control.watchPr ${repo}#${number}`)
      return fake.watchPr?.() ?? Effect.void
    }),
  unwatchPr: () =>
    Effect.suspend(() => {
      calls.push("control.unwatchPr")
      return fake.unwatchPr?.() ?? Effect.void
    }),
  list: () => Effect.succeed([]),
  get: () => Effect.fail(new ControlError({ message: "unused" })),
  create: () => Effect.fail(new ControlError({ message: "unused" })),
  update: () => Effect.fail(new ControlError({ message: "unused" })),
  remove: () => Effect.void,
  reportToolFailures: () => Effect.void,
})

/** `calls` records the control plane calls and the thread-registry writes the watch tools make, in order. */
const withClient = async (
  run: (client: Client, calls: string[]) => Promise<void>,
  control: FakeControl | null = null,
): Promise<void> => {
  const calls: string[] = []
  const server = new McpServer({ name: "automation-test", version: "1" })
  registerAutomationTools(server, { taskId: "task", runId: "run" }, {
    automations: {
      control: control === null ? null : fakeControl(calls, control),
      taskOwner: () => Effect.succeed("owner"),
      setWatching: (_taskId, repo, number, watching) =>
        Effect.sync(() => {
          calls.push(`setWatching ${repo}#${number} ${watching}`)
        }),
      // A no-op that records the call: the real one tolerates a missing entry, which is the case these tests exercise.
      forgetWatching: (_taskId, repo, number) =>
        Effect.sync(() => {
          calls.push(`forgetWatching ${repo}#${number}`)
        }),
      clearWatching: () =>
        Effect.sync(() => {
          calls.push("clearWatching")
        }),
    },
  })
  const client = new Client({ name: "automation-test", version: "1" })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await run(client, calls)
  } finally {
    await client.close()
    await server.close()
  }
}

describe("automation MCP contract", () => {
  test("exposes object triggers and homogeneous event arrays in Codex's supported schema subset", () =>
    withClient(async (client) => {
      const { tools } = await client.listTools()
      for (const name of ["automation_create", "automation_update"]) {
        const tool = tools.find((tool) => tool.name === name)
        // Codex lowers oneOf-only schemas to strings and cannot deserialize tuple-valued items.
        // These are wire-contract constraints, not snapshots of all the tool's metadata.
        expect(tool?.inputSchema.properties?.trigger).toMatchObject({
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: "object", required: expect.arrayContaining(["_tag", "cron", "timezone"]) }),
            expect.objectContaining({
              type: "object",
              required: expect.arrayContaining(["_tag", "events"]),
              properties: expect.objectContaining({
                events: expect.objectContaining({
                  type: "array", minItems: 1, items: expect.objectContaining({ type: "string", enum: expect.any(Array) }),
                }),
              }),
            }),
          ]),
        })
      }
    }))

  test("rejects an empty GitHub event list at the MCP boundary", () =>
    withClient(async (client) => {
      const result = await client.callTool({
        name: "automation_create",
        arguments: {
          name: "PR reviews",
          prompt: "Review the pull request",
          repo: "acme/app",
          trigger: { _tag: "github", events: [] },
        },
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Input validation error") }),
      ])
    }))
})

describe("github_pr_watch ownership", () => {
  test("a refused watch records nothing on the thread", () =>
    withClient(
      async (client, calls) => {
        const result = await client.callTool({ name: "github_pr_watch", arguments: { repo: "acme/app", number: 99 } })
        expect(result.isError).toBe(true)
        expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "pull request not found" })])
        // No registry write: a phantom entry would make the next watch look owned.
        expect(calls).toEqual(["control.watchPr acme/app#99"])
      },
      { watchPr: () => Effect.fail(new ControlError({ message: "pull request not found" })) },
    ))

  test("an accepted watch is recorded only after the control plane takes it", () =>
    withClient(
      async (client, calls) => {
        const result = await client.callTool({ name: "github_pr_watch", arguments: { repo: "acme/app", number: 9 } })
        expect(result.isError).toBeUndefined()
        expect(calls).toEqual(["control.watchPr acme/app#9", "setWatching acme/app#9 true"])
      },
      {},
    ))

  test("unwatching succeeds even when the thread's registry entry is already gone", () =>
    withClient(
      async (client, calls) => {
        const result = await client.callTool({ name: "github_pr_unwatch", arguments: { repo: "acme/app", number: 9 } })
        expect(result.isError).toBeUndefined()
        expect(calls).toEqual(["control.unwatchPr", "forgetWatching acme/app#9"])
      },
      {},
    ))

  test("unwatching every pull request still clears all marks", () =>
    withClient(
      async (client, calls) => {
        const result = await client.callTool({ name: "github_pr_unwatch", arguments: {} })
        expect(result.isError).toBeUndefined()
        expect(calls).toEqual(["control.unwatchPr", "clearWatching"])
      },
      {},
    ))
})

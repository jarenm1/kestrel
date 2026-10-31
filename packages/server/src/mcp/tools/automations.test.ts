import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { registerAutomationTools } from "./automations"

const withClient = async (run: (client: Client) => Promise<void>): Promise<void> => {
  const server = new McpServer({ name: "automation-test", version: "1" })
  registerAutomationTools(server, { taskId: "task", runId: "run" }, {
    automations: { control: null, taskOwner: () => Effect.succeed("owner") },
  })
  const client = new Client({ name: "automation-test", version: "1" })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await run(client)
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

import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Effect } from "effect"
import { registerThreadTools, type ThreadToolDeps } from "./threads"

test("thread_close archives only the current thread using its owner", async () => {
  const calls: string[][] = []
  const deps = {
    threads: {
      owner: (id: string) => Effect.sync(() => { calls.push(["owner", id]); return "owner" }),
      archive: (owner: string, id: string) => Effect.sync(() => { calls.push(["archive", owner, id]); return {} }),
    },
  } as unknown as ThreadToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerThreadTools(server, { taskId: "current", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: "thread_close", arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([["owner", "current"], ["archive", "owner", "current"]])
  } finally {
    await client.close()
    await server.close()
  }
})

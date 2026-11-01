import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Effect } from "effect"
import { registerThreadTools, type ThreadToolDeps } from "./threads"

test("thread_spawn creates an owned thread, checks out the repository, and sends the task from the current thread", async () => {
  const calls: unknown[][] = []
  const deps = { threads: {
    owner: (id: string) => Effect.sync(() => { calls.push(["owner", id]); return "owner" }),
    create: (owner: string, input: unknown) => Effect.sync(() => { calls.push(["create", owner, input]); return { id: "new", title: "Review" } }),
    send: (from: string, to: string, message: string) => Effect.sync(() => { calls.push(["send", from, to, message]); return { run: { id: "new-run" } } }),
  } } as unknown as ThreadToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerThreadTools(server, { taskId: "current", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: "thread_spawn", arguments: { title: "Review", message: "Review this", repo: "jarenm1/kestrel", baseBranch: "main" } })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain("new-run")
    expect(calls).toEqual([
      ["owner", "current"],
      ["create", "owner", { title: "Review", checkout: { repo: "jarenm1/kestrel", baseBranch: "main" } }],
      ["send", "current", "new", "Review this"],
    ])
    const invalid = await client.callTool({ name: "thread_spawn", arguments: { title: "Review", message: "Task", baseBranch: "main" } })
    expect(invalid.isError).toBe(true)
    expect(calls).toHaveLength(3)
  } finally {
    await client.close()
    await server.close()
  }
})

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

test("thread_spawn identifies the created thread when starting its agent fails", async () => {
  const deps = { threads: {
    owner: () => Effect.succeed("owner"),
    create: () => Effect.succeed({ id: "new", title: "Task" }),
    send: () => Effect.fail(new Error("could not start")),
  } } as unknown as ThreadToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerThreadTools(server, { taskId: "current", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: "thread_spawn", arguments: { title: "Task", message: "Do work" } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("Created thread new")
    expect(JSON.stringify(result)).toContain("could not start")
  } finally {
    await client.close()
    await server.close()
  }
})

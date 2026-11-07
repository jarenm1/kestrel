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

test("delegate_batch validates every checkout before starting work and uses stable per-item keys", async () => {
  const calls: Array<{ requestId: string; message: string }> = []
  const deps = { threads: {
    delegate: (_taskId: string, _runId: string, input: { requestId: string; message: string }) => Effect.sync(() => {
      calls.push(input)
      return { id: `child-${calls.length}` }
    }),
  } } as unknown as ThreadToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerThreadTools(server, { taskId: "parent", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toContain("delegate_batch")
    const invalid = await client.callTool({ name: "delegate_batch", arguments: { requestId: "batch", context: "context", tasks: [{ title: "One", message: "one" }, { title: "Two", message: "two", baseBranch: "main" }] } })
    expect(invalid.isError).toBe(true)
    expect(calls).toHaveLength(0)
    const result = await client.callTool({ name: "delegate_batch", arguments: { requestId: "batch", context: "context", tasks: [{ title: "One", message: "one" }, { title: "Two", message: "two" }] } })
    expect(result.isError).not.toBe(true)
    expect(calls.map((call) => call.requestId)).toEqual(["batch:batch:0", "batch:batch:1"])
    expect(calls[0]?.message).toContain("context")
    expect(calls[1]?.message).toContain("two")
  } finally {
    await client.close()
    await server.close()
  }
})

test("delegation_wait acknowledges only after regaining capacity and preserves recovery on interruption", async () => {
  let acknowledged = false
  let failReacquisition = true
  let needsInput = false
  let usageLimited = false
  const deps = { threads: {
    delegatedStatus: () => Effect.succeed({
      task: { id: "child", title: "Child", status: needsInput ? "needs_input" : usageLimited ? "failed" : "completed" },
      run: { id: "child-run", status: needsInput || usageLimited ? "failed" : "succeeded" },
      result: "Completed work", resultStatus: "succeeded", waitingForChildren: false,
      usageLimit: usageLimited ? { resetsAt: "2026-11-08T12:00:00.000Z" } : null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, structured: null,
    }),
    acknowledgeDelegation: () => Effect.sync(() => { acknowledged = true; return true }),
    withSlotReleased: <A, E>(_task: string, _run: string, wait: Effect.Effect<A, E>) => Effect.gen(function* () {
      const result = yield* wait
      // The child finished, but the parent still cannot receive the response.
      expect(acknowledged).toBe(false)
      if (failReacquisition) return yield* Effect.fail(new Error("interrupted while reacquiring capacity"))
      return result
    }),
  } } as unknown as ThreadToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerThreadTools(server, { taskId: "parent", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const interrupted = await client.callTool({ name: "delegation_wait", arguments: { threadId: "child" } })
    expect(interrupted.isError).toBe(true)
    expect(acknowledged).toBe(false)
    failReacquisition = false
    needsInput = true
    const question = await client.callTool({ name: "delegation_wait", arguments: { threadId: "child" } })
    expect(question.isError).not.toBe(true)
    expect(JSON.stringify(question)).toContain("needs user input")
    expect(acknowledged).toBe(false)
    needsInput = false
    // A child stopped by a usage limit resumes at the reset: waiting on it times out without taking its result.
    usageLimited = true
    const stalled = await client.callTool({ name: "delegation_wait", arguments: { threadId: "child", timeoutSec: 1 } })
    expect(JSON.stringify(stalled)).toContain("resumes automatically at 2026-11-08T12:00:00.000Z")
    expect(JSON.stringify(stalled)).toContain("Wait timed out")
    expect(acknowledged).toBe(false)
    usageLimited = false
    const completed = await client.callTool({ name: "delegation_wait", arguments: { threadId: "child" } })
    expect(completed.isError).not.toBe(true)
    expect(JSON.stringify(completed)).toContain("Completed work")
    expect(acknowledged).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

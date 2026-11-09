import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Run } from "@cloudagents/protocol"
import { Effect } from "effect"
import type { BrokerGrant } from "../broker"
import { createMcpHandler, type McpDeps } from "./handler"

interface Box {
  readonly url: string
  readonly issue: (
    token: string,
    run: Partial<Run> & Pick<Run, "id" | "taskId">,
    user?: string,
  ) => void
  readonly revoke: (runId: string) => void
  readonly notifyRevoke: (runId: string) => void
  readonly endRun: (runId: string) => void
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
})

const token = (runId: string) => `token-${runId}`

/** A box whose broker grants and runs are mutable, so a test can revoke or settle a run between requests. */
const startBox = async (): Promise<Box> => {
  const grants = new Map<string, BrokerGrant>()
  const runs = new Map<string, Run>()
  const listeners = new Set<(runId: string) => void>()
  const deps = {
    auth: {
      grantFor: (value: string) => Effect.sync(() => grants.get(value) ?? null),
      runFor: (id: string) => Effect.sync(() => runs.get(id) ?? null),
      onRevoke: (listener: (runId: string) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  } as unknown as McpDeps
  const handler = createMcpHandler(deps)
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, "127.0.0.1", listening.resolve)
  await listening.promise
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    issue: (value, run, user = "alice") => {
      grants.set(value, {
        runId: run.id,
        user,
        expiresAt: Date.now() + 60_000,
        providers: ["openrouter"],
        opencodeSession: "ses_test",
        opencodeGoKey: null,
      })
      runs.set(run.id, {
        prompt: "",
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        ...run,
      })
    },
    revoke: (runId) => {
      grants.delete(token(runId))
      for (const listener of listeners) listener(runId)
    },
    notifyRevoke: (runId) => {
      for (const listener of listeners) listener(runId)
    },
    endRun: (runId) => {
      const run = runs.get(runId)
      if (run !== undefined) runs.set(runId, { ...run, status: "succeeded", endedAt: new Date().toISOString() })
    },
  }
}

const initialize = (box: Box, taskId: string, accessToken: string): Promise<Response> =>
  fetch(`${box.url}/mcp/${taskId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "handler-test", version: "1" },
      },
    }),
  })

const withSession = (box: Box, taskId: string, accessToken: string, sessionId: string): Promise<Response> =>
  fetch(`${box.url}/mcp/${taskId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  })

const sessionIdOf = (response: Response): string => {
  const id = response.headers.get("mcp-session-id")
  if (id === null) throw new Error(`initialize did not open a session (status ${response.status})`)
  return id
}

describe("MCP session lifecycle", () => {
  test("a duplicate initialize closes the previous session for the run", async () => {
    const box = await startBox()
    box.issue(token("run-1"), { id: "run-1", taskId: "task-1" })
    const first = await initialize(box, "task-1", token("run-1"))
    expect(first.status).toBe(200)
    const firstId = sessionIdOf(first)

    const second = await initialize(box, "task-1", token("run-1"))
    expect(second.status).toBe(200)
    const secondId = sessionIdOf(second)
    expect(secondId).not.toBe(firstId)

    // The orphaned session is gone; the retried one serves.
    expect((await withSession(box, "task-1", token("run-1"), firstId)).status).toBe(404)
    expect((await withSession(box, "task-1", token("run-1"), secondId)).status).not.toBe(404)
  })

  test("a session whose run has ended is refused", async () => {
    const box = await startBox()
    box.issue(token("run-2"), { id: "run-2", taskId: "task-2" })
    const sessionId = sessionIdOf(await initialize(box, "task-2", token("run-2")))
    box.endRun("run-2")
    expect((await withSession(box, "task-2", token("run-2"), sessionId)).status).toBe(401)
  })

  test("revoking the run closes its sessions", async () => {
    const box = await startBox()
    box.issue(token("run-3"), { id: "run-3", taskId: "task-3" })
    const sessionId = sessionIdOf(await initialize(box, "task-3", token("run-3")))
    // Only the revoke notification reaches the handler: the grant still authorizes, so the session lookup is what fails.
    box.notifyRevoke("run-3")
    expect((await withSession(box, "task-3", token("run-3"), sessionId)).status).toBe(404)

    // The real revoke path removes the grant too; either way the token cannot open or reuse a session.
    box.issue(token("run-3b"), { id: "run-3b", taskId: "task-3" })
    const live = sessionIdOf(await initialize(box, "task-3", token("run-3b")))
    box.revoke("run-3b")
    expect((await withSession(box, "task-3", token("run-3b"), live)).status).toBe(401)
  })

  test("every admitted run of one user gets a session: a parent and a full delegated batch", async () => {
    const box = await startBox()
    // `delegate_batch` accepts ten children; with the parent that is eleven concurrent runs for one user.
    const runIds = Array.from({ length: 11 }, (_, index) => `batch-${index}`)
    for (const runId of runIds) box.issue(token(runId), { id: runId, taskId: `task-${runId}` })
    const opened = await Promise.all(runIds.map((runId) => initialize(box, `task-${runId}`, token(runId))))
    expect(opened.map((response) => response.status)).toEqual(runIds.map(() => 200))

    const sessions = opened.map(sessionIdOf)
    const served = await Promise.all(
      runIds.map((runId, index) => withSession(box, `task-${runId}`, token(runId), sessions[index]!)),
    )
    expect(served.map((response) => response.status)).toEqual(runIds.map(() => 200))
  })
})

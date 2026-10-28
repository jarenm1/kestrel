import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Run } from "@cloudagents/protocol"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import type { BrokerGrant } from "../broker"
import { type RunContext, describeError } from "./tools/common"
import { type DesktopToolDeps, registerDesktopTools } from "./tools/desktop"
import { type AutomationToolDeps, registerAutomationTools } from "./tools/automations"
import { type GitHubToolDeps, registerGitHubTools } from "./tools/github"
import { type TaskToolDeps, registerTaskTools } from "./tools/task"
import { type WorkspaceToolDeps, registerWorkspaceTools } from "./tools/workspace"

export interface McpAuthDeps {
  readonly auth: {
    /** Grant for a live broker token; null when unknown or revoked. */
    readonly grantFor: (token: string) => Effect.Effect<BrokerGrant | null>
    /** The run with this id, if it exists. */
    readonly runFor: (runId: string) => Effect.Effect<Run | null, unknown>
    /** Calls the listener with the run id whenever that run's token is revoked. Returns the unsubscribe. */
    readonly onRevoke: (listener: (runId: string) => void) => () => void
  }
}

export type McpDeps = McpAuthDeps & DesktopToolDeps & WorkspaceToolDeps & TaskToolDeps & GitHubToolDeps & AutomationToolDeps

const MCP_PATH = /^\/mcp\/([^/?#]+)/

const buildServer = (ctx: RunContext, deps: McpDeps): McpServer => {
  const server = new McpServer(
    { name: "cloudagents", version: "0.1.0" },
    {
      instructions:
        "Tools for the task's remote desktop (a virtual X display streamed to the user) and its git worktree. " +
        "Desktop coordinates are pixels with the origin at the top-left; call desktop_screenshot first to see the " +
        "desktop and its size. Use task_report to tell the user when you are done, task_ask to ask them a question " +
        "and wait for the answer, and task_inbox between steps to read messages the user sent during the run.",
    },
  )
  registerDesktopTools(server, ctx, deps)
  registerWorkspaceTools(server, ctx, deps)
  registerTaskTools(server, ctx, deps)
  registerAutomationTools(server, ctx, deps)
  registerGitHubTools(server, ctx, deps)
  return server
}

const sendJsonRpcError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }))
}

type ParsedBody = { ok: true; value: unknown } | { ok: false }

const readJsonBody = (req: IncomingMessage): Promise<ParsedBody> => {
  const { promise, resolve, reject } = Promise.withResolvers<ParsedBody>()
  let data = ""
  req.setEncoding("utf8")
  req.on("data", (chunk: string) => {
    data += chunk
  })
  req.on("end", () => {
    try {
      resolve({ ok: true, value: JSON.parse(data) as unknown })
    } catch {
      resolve({ ok: false })
    }
  })
  req.on("error", reject)
  return promise
}

const bearerToken = (req: IncomingMessage): string | null => {
  const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")
  return match?.[1] ?? null
}

interface Session {
  readonly runId: string
  readonly transport: StreamableHTTPServerTransport
}

/**
 * Returns a node http handler for every request whose URL starts with /mcp/<taskId>.
 * Stateful streamable HTTP: one McpServer + transport per session, keyed by Mcp-Session-Id.
 * Every request must carry the bearer token of a live run of that task; a session belongs to the run that opened it
 * and is closed when that run's token is revoked.
 */
export function createMcpHandler(deps: McpDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sessions = new Map<string, Session>()

  const closeSession = (id: string): void => {
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    void session.transport.close()
  }

  deps.auth.onRevoke((runId) => {
    for (const [id, session] of sessions) {
      if (session.runId === runId) closeSession(id)
    }
  })

  /** The run a request speaks for: the token is live, the run belongs to `taskId`, and the run is still running. */
  const authorize = async (token: string | null, taskId: string): Promise<string | null> => {
    if (token === null) return null
    const grant = await Effect.runPromise(deps.auth.grantFor(token))
    if (grant === null) return null
    const run = await Effect.runPromise(deps.auth.runFor(grant.runId))
    if (run === null || run.taskId !== taskId || run.status !== "running") return null
    return run.id
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = MCP_PATH.exec(req.url ?? "")
    if (!match?.[1]) {
      sendJsonRpcError(res, 404, -32000, "Not found")
      return
    }
    const taskId = decodeURIComponent(match[1])

    const method = req.method ?? "GET"
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      res.setHeader("allow", "GET, POST, DELETE")
      sendJsonRpcError(res, 405, -32000, "Method not allowed")
      return
    }

    const token = bearerToken(req)
    const runId = await authorize(token, taskId)
    if (runId === null) {
      res.setHeader("www-authenticate", "Bearer")
      sendJsonRpcError(res, 401, -32001, "Unauthorized")
      return
    }

    const header = req.headers["mcp-session-id"]
    const sessionId = Array.isArray(header) ? header[0] : header

    if (sessionId !== undefined) {
      const session = sessions.get(sessionId)
      if (!session || session.runId !== runId) {
        sendJsonRpcError(res, 404, -32001, "Session not found")
        return
      }
      if (method === "POST") {
        const body = await readJsonBody(req)
        if (!body.ok) {
          sendJsonRpcError(res, 400, -32700, "Parse error")
          return
        }
        await session.transport.handleRequest(req, res, body.value)
        return
      }
      await session.transport.handleRequest(req, res)
      return
    }

    if (method !== "POST") {
      sendJsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided")
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJsonRpcError(res, 400, -32700, "Parse error")
      return
    }
    if (!isInitializeRequest(body.value)) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided")
      return
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { runId, transport })
      },
    })
    transport.onclose = () => {
      const id = transport.sessionId
      if (id !== undefined && sessions.get(id)?.transport === transport) sessions.delete(id)
    }
    await buildServer({ taskId, runId }, deps).connect(transport)
    await transport.handleRequest(req, res, body.value)
    // A revoke that landed while this session was being set up could not see it; close it now.
    const id = transport.sessionId
    if (id !== undefined && (await authorize(token, taskId)) !== runId) closeSession(id)
  }

  return async (req, res) => {
    try {
      await handle(req, res)
    } catch (e) {
      console.error("[mcp] request failed:", describeError(e))
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, "Internal server error")
      else res.end()
    }
  }
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit } from "effect"

/** The run an MCP session speaks for: its tools act on this task and this run only. */
export interface RunContext {
  readonly taskId: string
  readonly runId: string
}

export const MAX_OUTPUT_CHARS = 20_000

export const describeError = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

/** Runs an Effect, rejecting with the underlying error (not a FiberFailure wrapper). */
export const runTool = (effect: Effect.Effect<CallToolResult, unknown>): Promise<CallToolResult> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  })

export const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] })

/** Any failure becomes an MCP tool error (isError), never a server crash. */
export const guard = (fn: () => Promise<CallToolResult>): Promise<CallToolResult> =>
  fn().catch((e: unknown) => ({
    content: [{ type: "text", text: describeError(e) }],
    isError: true,
  }))

export const truncate = (s: string): string =>
  s.length <= MAX_OUTPUT_CHARS ? s : `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`

import { Effect } from "effect"
import { MAX_TOOL_FAILURES_PER_REPORT, type ToolFailureCount, type ToolFailureReport } from "@cloudagents/protocol"

const MAX_SIGNATURE = 200
const MAX_OUTPUT = 8192
const MAX_TOOL_NAME = 100
const FLUSH_MS = 60_000
/** Shutdown waits for the last report this long at most; telemetry never holds up a restart. */
const SHUTDOWN_FLUSH = "3 seconds"

/** Tools whose output is whatever a command or someone else's server wrote, not an error Kestrel or the harness wrote. */
const OPEN_OUTPUT_TOOLS = new Set([
  "Bash",
  "command_execution",
  "mcp__cloudagents__workspace_exec",
  "cloudagents.workspace_exec",
  "mcp__other",
  "mcp.other",
])
const ERROR_LINE =
  /\b(error|errors|failed|failure|fatal|panic|exception|denied|forbidden|unauthorized|refused|cannot|can't|could not|unable|invalid|not found|no such|not available|not allowed|timed? ?out|unknown|missing|unexpected|segmentation fault)\b/i
// The user stopped the call or declined it; neither says anything about the tool.
const USER_STOPPED = /request interrupted by user|the user doesn't want to proceed with this tool use/i
const EXIT_CODE = /^exit code (-?\d+)$/i

// Order matters: each pattern relies on the ones before it having taken their part of the line.
const SCRUBS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, "<url>"],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>"],
  [/\b(password|passwd|secret|token|api[_-]?key|authorization|credential|cookie)(s?)(\s*[:=]\s*)((bearer|basic)\s+)?\S+/gi, "$1$2$3<redacted>"],
  [/\b(bearer|basic)\s+\S+/gi, "$1 <redacted>"],
  [/\b([A-Za-z_][\w.-]*)=\S+/g, "$1=<value>"],
  [/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g, "<str>"],
  [/\b[a-z]:\\\S*/gi, "<path>"],
  [/(^|[\s(=:[])(~|\.{1,2})?\/\S*/g, "$1<path>"],
  [/\b[\w.@-]+(\/[\w.@-]+)+\/?(:\d+)*/g, "<path>"],
  [/\b[\w-]+(\.[\w-]+)*\.[a-z][a-z0-9]{0,5}\b(:\d+)*/gi, "<file>"],
  [/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]+\b/gi, "<id>"],
  [/\b[A-Za-z0-9_-]{24,}\b/g, "<id>"],
  [/\d+/g, "<n>"],
]

const scrub = (line: string): string => {
  let text = line
  for (const [pattern, replacement] of SCRUBS) text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE).trimEnd()
}

/**
 * What a failed call's output has in common with others like it: the line naming the error, with whatever is specific
 * to the run scrubbed out. Open output is the user's own data until it looks like an error, so the first line only
 * stands in for an error on other tools.
 */
export const failureSignature = (tool: string, output: string | null): string => {
  // Never run the scrubber on unbounded input or a truncated secret.
  if (output !== null && output.length > MAX_OUTPUT) return "(output too large)"
  const plain = (output ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/<\/?tool_use_error>/g, "")
  const lines = plain.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
  const exit = lines[0]?.match(EXIT_CODE)
  const rest = exit ? lines.slice(1) : lines
  const line = rest.find((l) => ERROR_LINE.test(l)) ?? (OPEN_OUTPUT_TOOLS.has(tool) ? undefined : rest[0])
  const signature = line === undefined ? "" : scrub(line)
  if (signature !== "") return signature
  if (exit) return `exit code ${exit[1]}`
  return lines.length === 0 ? "(no output)" : "(no error line)"
}

/** Harness tools keep their names, Kestrel's own MCP tools too; another MCP server's name can say what a user works on. */
const toolLabel = (name: string): string => {
  if (name.startsWith("mcp__")) return name.startsWith("mcp__cloudagents__") ? name : "mcp__other"
  if (name.includes(".")) return name.startsWith("cloudagents.") ? name : "mcp.other"
  return name.slice(0, MAX_TOOL_NAME)
}

/** The failure to count for a failed call; null when the user stopped or declined the call. */
export const toolFailure = (name: string, output: string | null): Omit<ToolFailureCount, "count"> | null => {
  if (output !== null && output.length <= MAX_OUTPUT && USER_STOPPED.test(output)) return null
  const tool = toolLabel(name)
  return { tool, signature: failureSignature(tool, output) }
}

/**
 * A Codex turn's end closes the commands it left running as errors. A stop or a steer cut them off, so the turn's
 * own completion is not evidence the tool failed; a command that really failed was reported by its own item first.
 */
export const endsCodexTurn = (message: unknown): boolean =>
  typeof message === "object" && message !== null && "method" in message && message.method === "turn/completed"

/** A declined Codex action is a user decision, even though its transcript item is shown as an error. */
export const declinedCodexItem = (message: unknown, itemId: string): boolean => {
  if (typeof message !== "object" || message === null || !("method" in message) || message.method !== "item/completed" || !("params" in message)) return false
  const params = message.params
  if (typeof params !== "object" || params === null || !("item" in params)) return false
  const item = params.item
  return typeof item === "object" && item !== null && "id" in item && item.id === itemId && "status" in item && item.status === "declined"
}

/** Only retain a scrubbed error line from CLI diagnostics, never arbitrary output. */
export const agentDiagnostic = (text: string): string | null => {
  const signature = failureSignature("Bash", text)
  return signature === "(no error line)" || signature === "(no output)" || signature === "(output too large)" ? null : signature
}

export const agentFailure = (agent: "claude" | "codex", error: string | null, diagnostic: string | null, exitCode: number | null, signal: string | null): Omit<ToolFailureCount, "count"> => {
  const earlyExit = error === (agent === "claude" ? "Claude Code exited before its turn finished." : "Codex exited before its turn finished.")
  const prefix = earlyExit ? "exited before turn finished" : "turn failed"
  const termination = [exitCode === null ? null : `exit code ${exitCode}`, signal === null ? null : `signal ${signal}`].filter((part) => part !== null).map((part) => `: ${part}`).join("")
  const detail = (error === null || earlyExit ? null : agentDiagnostic(`error: ${error}`)) ?? diagnostic
  const available = Math.max(0, MAX_SIGNATURE - prefix.length - termination.length - 2)
  const signature = `${prefix}${detail && available > 0 ? `: ${detail.slice(0, available).trimEnd()}` : ""}${termination}`.slice(0, MAX_SIGNATURE)
  return { tool: `agent:${agent}`, signature }
}

export interface ToolFailureReporter {
  readonly record: (failure: Omit<ToolFailureCount, "count">) => void
  /** Sends what is pending and waits for it, briefly; for shutdown. */
  readonly flush: Effect.Effect<void>
}

/**
 * Collects failures and sends their counts at most once per `flushMs`. Best effort: a report that does not arrive is
 * dropped rather than kept, and nothing here ever reaches the run that failed.
 */
export const makeToolFailureReporter = (
  send: (report: ToolFailureReport) => Effect.Effect<void, { readonly message: string }>,
  flushMs = FLUSH_MS,
): ToolFailureReporter => {
  let pending = new Map<string, ToolFailureCount>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const sendPending = Effect.suspend(() => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (pending.size === 0) return Effect.void
    const failures = [...pending.values()]
    pending = new Map()
    return send({ failures }).pipe(
      Effect.catchAll((e) => Effect.logWarning(`could not report ${failures.length} tool failures: ${e.message}`)),
    )
  })

  return {
    record: (failure) => {
      const key = JSON.stringify([failure.tool, failure.signature])
      const known = pending.get(key)
      if (known !== undefined) pending.set(key, { ...known, count: known.count + 1 })
      else if (pending.size < MAX_TOOL_FAILURES_PER_REPORT) pending.set(key, { ...failure, count: 1 })
      if (timer === null) {
        timer = setTimeout(() => Effect.runFork(sendPending), flushMs)
        timer.unref()
      }
    },
    flush: sendPending.pipe(Effect.timeout(SHUTDOWN_FLUSH), Effect.ignore),
  }
}

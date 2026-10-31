import type { RunDriver, RunOutcome } from "./run-driver"
import { isRecord } from "./transcript"

/*
 * A Claude run reads its prompt from stdin (`--input-format stream-json`) instead of argv, so the box can keep
 * talking to it while the turn runs:
 * - a user message written mid-turn joins it: Claude Code takes it at its next step (after the running tool), or,
 *   while it is only writing text, as the next turn of the same run;
 * - Stop sends an `interrupt` control request, and the turn ends with an interrupted result in its session.
 * After the first `result` the box closes stdin: Claude Code still runs the messages it already has, then exits.
 */

/** One user message on Claude Code's stream-json input. */
const userMessage = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })

export interface ClaudeDriverIo {
  /** Writes one stream-json line to the CLI's stdin. */
  readonly send: (message: unknown) => void
  /** The run's first turn is over: stdin can close. Called once. */
  readonly onDone: (outcome: RunOutcome) => void
}

export const makeClaudeDriver = (prompt: string, io: ClaudeDriverIo): RunDriver => {
  /** Whether the box may still write: true until the first result. */
  let open = true
  let interrupted = false
  let outcome: RunOutcome | null = null
  let nextRequest = 1

  return {
    start: () => io.send(userMessage(prompt)),
    receive: (message) => {
      if (!isRecord(message)) return
      if (message.type === "control_request" && typeof message.request_id === "string") {
        // Permissions are skipped and no hooks are registered, so nothing the CLI asks is expected; refuse it
        // rather than leave the turn waiting on an answer.
        io.send({
          type: "control_response",
          response: { subtype: "error", request_id: message.request_id, error: "Kestrel does not answer this request" },
        })
        return
      }
      if (message.type !== "result") return
      // A later result (a message queued behind the first turn) decides the run's outcome.
      outcome =
        message.is_error !== true ? { status: "completed" } : interrupted ? { status: "interrupted" } : { status: "failed", error: null }
      if (!open) return
      open = false
      io.onDone(outcome)
    },
    steer: (text) => {
      if (!open) return Promise.resolve(false)
      io.send(userMessage(text))
      return Promise.resolve(true)
    },
    interrupt: () => {
      if (!open) return false
      interrupted = true
      // Messages still waiting behind the turn go too: Stop ends the run.
      io.send({ type: "control_request", request_id: `kestrel-interrupt-${nextRequest++}`, request: { subtype: "interrupt", cancel_queued: true } })
      return true
    },
    close: () => {
      open = false
      outcome ??= { status: "failed", error: "Claude Code exited before its turn finished." }
    },
    outcome: () => outcome,
  }
}

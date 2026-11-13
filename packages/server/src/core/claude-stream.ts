import { randomUUID } from "node:crypto"
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

/**
 * One user message on Claude Code's stream-json input. `uuid` lets the CLI's `--replay-user-messages` echo identify
 * the message it took; only messages that can be taken later (steers) carry one.
 */
const userMessage = (text: string, uuid?: string) => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
  ...(uuid === undefined ? {} : { uuid }),
})

export interface ClaudeDriverIo {
  /** Writes one stream-json line to the CLI's stdin. */
  readonly send: (message: unknown) => void
  /**
   * Claude Code took a message the box steered, at its next step. It arrives as the replay of the message's `uuid`;
   * the run's first prompt is replayed too and is not reported.
   */
  readonly onTaken: (messageId: string) => void
  /** The run's first turn is over: stdin can close. Called once. */
  readonly onDone: (outcome: RunOutcome) => void
}

export const makeClaudeDriver = (prompt: string, io: ClaudeDriverIo): RunDriver => {
  /** Whether the box may still write: true until the first result. */
  let open = true
  let interrupted = false
  let outcome: RunOutcome | null = null
  let nextRequest = 1
  /** Steered messages by the uuid Claude Code replays when it takes them. */
  const steered = new Map<string, string>()

  return {
    start: () => io.send(userMessage(prompt)),
    receive: (message) => {
      if (!isRecord(message)) return
      if (message.type === "user" && message.isReplay === true && typeof message.uuid === "string") {
        const messageId = steered.get(message.uuid)
        if (messageId === undefined) return
        steered.delete(message.uuid)
        io.onTaken(messageId)
        return
      }
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
      // A later result (a message queued behind the first turn) decides the run's outcome. The first
      // result is not success for the whole run while Claude still reports queued work.
      const result: RunOutcome =
        message.is_error !== true ? { status: "completed" } : interrupted ? { status: "interrupted" } : { status: "failed", error: null }
      outcome = typeof message.queued_turn_count === "number" && message.queued_turn_count > 0 ? null : result
      if (!open) return
      open = false
      io.onDone(result)
    },
    steer: (text, messageId) => {
      if (!open) return Promise.resolve(false)
      const uuid = randomUUID()
      steered.set(uuid, messageId)
      io.send(userMessage(text, uuid))
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
      steered.clear()
      outcome ??= { status: "failed", error: "Claude Code exited before its turn finished." }
    },
    outcome: () => outcome,
  }
}

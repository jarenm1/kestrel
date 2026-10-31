import { describe, expect, test } from "bun:test"
import { makeClaudeDriver } from "./claude-stream"
import type { RunOutcome } from "./run-driver"

/** A driver wired to a recording CLI: `sent` is what it wrote to stdin, `done` each time it let stdin go. */
const harness = () => {
  const sent: unknown[] = []
  const done: RunOutcome[] = []
  const driver = makeClaudeDriver("user context\n\nfix the test", { send: (m) => sent.push(m), onDone: (o) => done.push(o) })
  return { driver, sent, done }
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })
const result = (isError = false) => ({ type: "result", subtype: isError ? "error_during_execution" : "success", is_error: isError })

describe("claude stream-json driver", () => {
  test("the prompt is the first user message; a message mid-turn joins it; stdin goes after the first result", async () => {
    const h = harness()
    h.driver.start()
    expect(h.sent).toEqual([user("user context\n\nfix the test")])
    expect(await h.driver.steer("use the other file")).toBe(true)
    expect(h.sent.at(-1)).toEqual(user("use the other file"))

    h.driver.receive(result())
    expect(h.done).toEqual([{ status: "completed" }])
    // Once stdin is closed a message cannot reach the run; it waits in the inbox instead.
    expect(await h.driver.steer("too late")).toBe(false)
    expect(h.sent).toHaveLength(2)
  })

  test("a message Claude Code queued behind the first turn decides the outcome, without reopening stdin", () => {
    const h = harness()
    h.driver.start()
    h.driver.receive(result())
    h.driver.receive(result(true))
    expect(h.done).toHaveLength(1)
    expect(h.driver.outcome()).toEqual({ status: "failed", error: null })
  })

  test("Stop interrupts the turn and drops queued messages; the error result that follows is an interrupt", () => {
    const h = harness()
    h.driver.start()
    expect(h.driver.interrupt()).toBe(true)
    expect(h.sent.at(-1)).toEqual({
      type: "control_request",
      request_id: expect.any(String),
      request: { subtype: "interrupt", cancel_queued: true },
    })
    h.driver.receive({ type: "control_response", response: { subtype: "success", request_id: "x" } })
    h.driver.receive(result(true))
    expect(h.done).toEqual([{ status: "interrupted" }])
    // With stdin closed, Stop has to signal the process instead.
    expect(h.driver.interrupt()).toBe(false)
  })

  test("a request from the CLI is refused rather than left waiting; an exit without a result fails the run", () => {
    const h = harness()
    h.driver.start()
    h.driver.receive({ type: "control_request", request_id: "req-7", request: { subtype: "can_use_tool", tool_name: "Bash" } })
    expect(h.sent.at(-1)).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: "req-7", error: expect.any(String) },
    })
    h.driver.close()
    expect(h.driver.outcome()).toEqual({ status: "failed", error: "Claude Code exited before its turn finished." })
    expect(h.done).toEqual([])
  })
})

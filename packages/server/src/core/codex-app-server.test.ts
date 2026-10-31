import { describe, expect, test } from "bun:test"
import { codexCommandOf, makeCodexDriver, type CodexOutcome, type CodexRunInput } from "./codex-app-server"

interface Sent {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: unknown
}

/** A driver wired to a recording app-server: `sent` is what the driver wrote, `reply` answers its last request. */
const harness = (overrides: Partial<CodexRunInput> = {}) => {
  const sent: Sent[] = []
  const threads: string[] = []
  const outcomes: CodexOutcome[] = []
  const driver = makeCodexDriver(
    { text: "fix the test", prompt: "user context\n\nfix the test", resumeThread: null, clientVersion: "1.2.3", ...overrides },
    { send: (m) => sent.push(m as Sent), onThread: (id) => threads.push(id), onDone: (o) => outcomes.push(o) },
  )
  const last = () => sent.at(-1) as Sent
  const reply = (result: unknown) => driver.receive({ id: last().id, result })
  const methods = () => sent.map((m) => m.method ?? "(reply)")
  return { driver, sent, threads, outcomes, last, reply, methods }
}

const turnCompleted = (id: string, status: string) => ({
  method: "turn/completed",
  params: { threadId: "th1", turn: { id, items: [], status, error: null } },
})

describe("codex app-server driver", () => {
  test("a fresh run initializes, starts a thread without Codex's sandbox or approvals, and sends the prompt", () => {
    const h = harness({ model: "gpt-6-luna", effort: "high" })
    h.driver.start()
    expect(h.last()).toMatchObject({ method: "initialize", params: { clientInfo: { name: "kestrel", version: "1.2.3" } } })
    h.reply({ userAgent: "codex" })
    expect(h.sent.at(-2)).toEqual({ method: "initialized", params: {} })
    expect(h.last()).toMatchObject({
      method: "thread/start",
      params: { approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-6-luna" },
    })
    h.reply({ thread: { id: "th1" }, model: "gpt-6-luna" })
    expect(h.threads).toEqual(["th1"])
    expect(h.last()).toEqual({
      method: "turn/start",
      id: expect.any(Number),
      params: { threadId: "th1", input: [{ type: "text", text: "user context\n\nfix the test", text_elements: [] }], effort: "high" },
    })
    h.reply({ turn: { id: "tu1", status: "inProgress" } })
    expect(h.outcomes).toEqual([])
    h.driver.receive(turnCompleted("tu1", "completed"))
    expect(h.outcomes).toEqual([{ status: "completed" }])
    expect(h.driver.outcome()).toEqual({ status: "completed" })
  })

  test("a resumed run signs in with the broker key first and resumes the thread; a refused resume fails the run", () => {
    const h = harness({ resumeThread: "th-old", apiKey: "run-token" })
    h.driver.start()
    h.reply({})
    expect(h.last()).toMatchObject({ method: "account/login/start", params: { type: "apiKey", apiKey: "run-token" } })
    h.reply({ type: "apiKey" })
    expect(h.last()).toMatchObject({ method: "thread/resume", params: { threadId: "th-old", excludeTurns: true, approvalPolicy: "never" } })
    h.driver.receive({ id: h.last().id, error: { code: -32600, message: "no rollout found for thread th-old" } })
    expect(h.outcomes).toEqual([{ status: "failed", error: "thread/resume: no rollout found for thread th-old" }])
    expect(h.methods()).not.toContain("turn/start")
  })

  test("/review runs a review with the given instructions and ends with its own turn, not the review's inner turns", () => {
    const h = harness({ text: "/review check the error handling", resumeThread: "th1" })
    h.driver.start()
    h.reply({})
    h.reply({ thread: { id: "th1" } })
    expect(h.last()).toMatchObject({
      method: "review/start",
      params: { threadId: "th1", target: { type: "custom", instructions: "check the error handling" } },
    })
    h.reply({ turn: { id: "tu-review" }, reviewThreadId: "th1" })
    h.driver.receive({ method: "turn/started", params: { threadId: "th1", turn: { id: "tu-inner" } } })
    h.driver.receive(turnCompleted("tu-inner", "completed"))
    expect(h.outcomes).toEqual([])
    h.driver.receive(turnCompleted("tu-review", "completed"))
    expect(h.outcomes).toEqual([{ status: "completed" }])
  })

  test("/compact needs a conversation; with one it compacts and follows the turn app-server starts for it", () => {
    const fresh = harness({ text: "/compact" })
    fresh.driver.start()
    expect(fresh.sent).toEqual([])
    expect(fresh.outcomes).toEqual([{ status: "failed", error: "There is no Codex conversation to compact yet." }])

    const h = harness({ text: "/compact", resumeThread: "th1" })
    h.driver.start()
    h.reply({})
    h.reply({ thread: { id: "th1" } })
    expect(h.last()).toMatchObject({ method: "thread/compact/start", params: { threadId: "th1" } })
    h.reply({})
    h.driver.receive({ method: "turn/started", params: { threadId: "th1", turn: { id: "tu-compact" } } })
    h.driver.receive(turnCompleted("tu-other", "completed"))
    expect(h.outcomes).toEqual([])
    h.driver.receive(turnCompleted("tu-compact", "completed"))
    expect(h.outcomes).toEqual([{ status: "completed" }])
  })

  test("/init sends Codex's own AGENTS.md prompt; other slash text is a plain prompt", () => {
    const h = harness({ text: "/init" })
    h.driver.start()
    h.reply({})
    h.reply({ thread: { id: "th1" } })
    const input = (h.last().params?.input as Array<{ text: string }>)[0]?.text ?? ""
    expect(input).toStartWith("Generate a file named AGENTS.md")
    expect(codexCommandOf("/model gpt")).toBeNull()
    expect(codexCommandOf("please /review this")).toBeNull()
    expect(codexCommandOf("  /review  ")).toEqual({ name: "review", args: "" })
  })

  test("steering needs a running turn and reports whether app-server took it; Stop interrupts the turn", async () => {
    const h = harness()
    h.driver.start()
    expect(await h.driver.steer("too early")).toBe(false)
    expect(h.driver.interrupt()).toBe(false)
    h.reply({})
    h.reply({ thread: { id: "th1" } })
    h.reply({ turn: { id: "tu1" } })

    const accepted = h.driver.steer("use the other file")
    expect(h.last()).toMatchObject({
      method: "turn/steer",
      params: { threadId: "th1", expectedTurnId: "tu1", input: [{ type: "text", text: "use the other file" }] },
    })
    h.reply({ turnId: "tu1" })
    expect(await accepted).toBe(true)

    const refused = h.driver.steer("again")
    h.driver.receive({ id: h.last().id, error: { message: "expected turn mismatch" } })
    expect(await refused).toBe(false)

    expect(h.driver.interrupt()).toBe(true)
    expect(h.last()).toMatchObject({ method: "turn/interrupt", params: { threadId: "th1", turnId: "tu1" } })
    h.driver.receive(turnCompleted("tu1", "interrupted"))
    expect(h.outcomes).toEqual([{ status: "interrupted" }])
    expect(await h.driver.steer("after the turn")).toBe(false)
  })

  test("approvals are accepted, other server requests refused; an exit fails the turn and pending steers", async () => {
    const h = harness()
    h.driver.start()
    h.reply({})
    h.reply({ thread: { id: "th1" } })
    h.reply({ turn: { id: "tu1" } })
    h.driver.receive({ id: 90, method: "item/commandExecution/requestApproval", params: {} })
    expect(h.last()).toEqual({ id: 90, result: { decision: "accept" } })
    h.driver.receive({ id: 91, method: "item/tool/requestUserInput", params: {} })
    expect(h.last()).toMatchObject({ id: 91, error: { code: -32601 } })

    const pending = h.driver.steer("are you there")
    h.driver.close()
    expect(await pending).toBe(false)
    expect(h.outcomes).toEqual([{ status: "failed", error: "Codex exited before its turn finished." }])
  })
})

/**
 * Deterministic stand-in for the agent harness (CLOUDAGENTS_FAKE_AGENT=1).
 * Runs with cwd = the thread's workspace and talks to the task's MCP endpoint like a real agent would. For OpenAI
 * models it is also the run's Codex app-server: it answers the harness's JSON-RPC on stdin and plays its turn.
 */
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

const mcpUrl = process.env.CLOUDAGENTS_MCP_URL
const mcpToken = process.env.CLOUDAGENTS_MCP_TOKEN
let prompt = process.env.CLOUDAGENTS_PROMPT ?? ""
const model = process.env.CLOUDAGENTS_MODEL
const effort = process.env.CLOUDAGENTS_EFFORT
const choice = [model === undefined ? null : `model: ${model}`, effort === undefined ? null : `effort: ${effort}`]
  .filter((part): part is string => part !== null)
  .join(", ")

if (!mcpUrl || !mcpToken) {
  console.error("fake-agent: CLOUDAGENTS_MCP_URL or CLOUDAGENTS_MCP_TOKEN is not set")
  process.exit(1)
}

const appServer = model?.startsWith("gpt-") === true
// A Claude run's first line names its session in Claude Code's stream-json init; a Codex run's thread is named in its
// `thread/start` or `thread/resume` response. A resumed run keeps its session.
let resumeSession = appServer ? undefined : process.env.CLOUDAGENTS_RESUME_SESSION
if (!appServer) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: resumeSession ?? randomUUID() }))
}

const client = new Client({ name: "cloudagents-fake-agent", version: "0.1.0" })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
})

const DEFAULT_CALL_TIMEOUT_MS = 60_000
// The longest timer the runtime accepts: a question waits as long as the user takes to answer.
const UNBOUNDED_CALL_MS = 2_147_483_647

const call = async (
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<{ failed: boolean; text: string }> => {
  console.log(`fake-agent: call ${name} ${JSON.stringify(args).slice(0, 200)}`)
  // Progress pings from the server reset the per-call timeout, so a call waiting on the user is not cut short.
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs,
    resetTimeoutOnProgress: true,
    onprogress: () => {},
  })) as CallToolResult
  const text = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
  console.log(`fake-agent: ${name} ${result.isError ? "error" : "ok"}: ${text.slice(0, 200)}`)
  return { failed: result.isError === true, text }
}

const runExecProbes = async (): Promise<number> => {
  const started = Date.now()
  const bg = await call("workspace_exec", { command: "sleep 30 & echo started" })
  console.log(`fake-agent: probe background elapsedMs=${Date.now() - started} firstLine=${bg.text.split("\n")[0]}`)
  const flood = await call("workspace_exec", { command: "yes | head -c 50000000" })
  const marker = flood.text.match(/\[\.\.\. \d+ bytes omitted \.\.\.\]/)
  console.log(`fake-agent: probe flood marker=${marker?.[0] ?? "none"} textLength=${flood.text.length}`)
  const timeout = await call("workspace_exec", { command: "yes", timeoutSec: 3 })
  console.log(`fake-agent: probe timeout firstLine=${timeout.text.split("\n")[0]}`)
  await call("task_report", { status: "done", message: "exec probes finished" })
  return 0
}

// Checks `repo` out into the thread, commits one file in the checkout and leaves another uncommitted, so the diff
// must show both. Reports the checkout's directory.
const runCheckoutProbe = async (repo: string): Promise<number> => {
  const checkout = await call("repo_checkout", { repo })
  const dir = /\bat (\S+) \(/.exec(checkout.text)?.[1]
  if (checkout.failed || dir === undefined) {
    await call("task_report", { status: "failed", message: `fake agent could not check out ${repo}` })
    return 1
  }
  const committed = await call("workspace_exec", {
    command: `cd '${dir}' && echo committed > CHECKOUT_PROBE.txt && git add CHECKOUT_PROBE.txt && git -c user.name=fake -c user.email=fake@example.com commit -qm "checkout probe"`,
  })
  const uncommitted = await call("workspace_exec", { command: `cd '${dir}' && echo uncommitted > UNCOMMITTED_PROBE.txt` })
  if (!committed.text.startsWith("exit code: 0") || !uncommitted.text.startsWith("exit code: 0")) {
    await call("task_report", { status: "failed", message: `fake agent could not change files in ${dir}` })
    return 1
  }
  await call("task_report", { status: "done", message: `checkout probe finished in ${dir}` })
  return 0
}

const sleepMs = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

// Drives the desktop tools against a live desktop: an xterm to type into, and a ticking app for output.
const runDesktopProbes = async (): Promise<number> => {
  // Before desktop_open the desktop is not running: the tool refuses, then the probe opens it.
  await call("desktop_screenshot", {})
  await call("desktop_open", {})
  const term = await call("desktop_launch", { command: "xterm -geometry 100x30+40+40 -e bash" })
  const ticker = await call("desktop_launch", {
    command: "sh -c 'echo probe-started; i=0; while :; do i=$((i+1)); echo tick-$i; sleep 1; done'",
  })
  const missing = await call("desktop_launch", { command: "no-such-app" })
  console.log(`fake-agent: probe missing-app failed=${missing.failed}`)
  const termId = /launched (app-\d+)/.exec(term.text)?.[1]
  const tickerId = /launched (app-\d+)/.exec(ticker.text)?.[1]
  if (!termId || !tickerId) {
    await call("task_report", { status: "failed", message: "desktop probe could not launch apps" })
    return 1
  }
  await sleepMs(3000)
  console.log(`fake-agent: processes\n${(await call("desktop_processes", { lines: 3 })).text}`)
  await call("desktop_click", { x: 300, y: 200, screenshot: true, settleMs: 500 })
  await call("desktop_type", { text: "echo hi" })
  await call("desktop_key", { key: "+", repeat: 3, holdMs: 50 })
  await call("desktop_key", { key: "Return" })
  await call("desktop_scroll", { x: 300, y: 200, direction: "down", amount: 5 })
  await call("desktop_drag", { fromX: 100, fromY: 100, toX: 200, toY: 120, steps: 5 })
  console.log(`fake-agent: cursor ${(await call("desktop_cursor_position", {})).text}`)
  console.log(`fake-agent: region ${(await call("desktop_screenshot", { region: { x: 0, y: 0, width: 640, height: 400 }, scale: 0.5 })).text}`)
  await call("desktop_kill", { id: tickerId })
  console.log(`fake-agent: processes after kill\n${(await call("desktop_processes", { lines: 3 })).text}`)
  await call("desktop_kill", { id: termId })
  await call("task_report", { status: "done", message: "desktop probes finished" })
  return 0
}

// Drives the automation tools: creates a schedule automation for this thread's owner, lists, updates its cron and
// deletes it. An optional automation id of another user must come back as not found.
const runAutomationProbes = async (foreignId: string | undefined): Promise<number> => {
  const created = await call("automation_create", {
    name: "probe",
    prompt: "automation probe prompt",
    trigger: { _tag: "schedule", cron: "0 13 * * 2", timezone: "UTC" },
  })
  const id = /created automation (\S+)/.exec(created.text)?.[1]
  if (created.failed || id === undefined) {
    await call("task_report", { status: "failed", message: "automation probe could not create" })
    return 1
  }
  console.log(`fake-agent: probe list\n${(await call("automation_list", {})).text}`)
  const updated = await call("automation_update", {
    id,
    trigger: { _tag: "schedule", cron: "30 9 * * 1", timezone: "UTC" },
  })
  console.log(`fake-agent: probe updated failed=${updated.failed}`)
  if (foreignId !== undefined) {
    const foreign = await call("automation_update", { id: foreignId, enabled: false })
    console.log(`fake-agent: probe foreign failed=${foreign.failed} text=${foreign.text.slice(0, 120)}`)
  }
  const removed = await call("automation_delete", { id })
  await call("task_report", {
    status: removed.failed || updated.failed ? "failed" : "done",
    message: "automation probes finished",
  })
  return removed.failed || updated.failed ? 1 : 0
}

// Installs a toolkit, checks its commands are on PATH for a new process, launches `gui` on the desktop and reports
// the desktop a while later with a screenshot.
const runToolkitProbe = async (name: string, gui: string): Promise<number> => {
  const installed = await call("toolkit_install", { name }, UNBOUNDED_CALL_MS)
  const found = await call("workspace_exec", { command: `command -v ${gui.split(" ")[0]} && ls ~/.kestrel/bin` })
  if (installed.failed || !found.text.startsWith("exit code: 0")) {
    await call("task_report", { status: "failed", message: `toolkit probe: ${installed.text} / ${found.text}` })
    return 1
  }
  await call("desktop_open", {})
  const launched = await call("desktop_launch", { command: gui })
  await sleepMs(45_000)
  console.log(`fake-agent: processes\n${(await call("desktop_processes", { lines: 20 })).text}`)
  await call("task_report", {
    status: launched.failed ? "failed" : "done",
    message: `toolkit probe: ${installed.text}; ${launched.text}`,
    attachScreenshot: true,
  })
  return launched.failed ? 1 : 0
}

// Asks the user a question with options and a screenshot, then polls the inbox for a message sent during the run.
const askAndListen = async (): Promise<{ answer: string; inbox: string } | null> => {
  // The question attaches the desktop, so it has to be running.
  await call("desktop_open", {})
  const asked = await call(
    "task_ask",
    { question: "Which colour should the notes use?", options: ["Blue", "Red"], attachScreenshot: true },
    UNBOUNDED_CALL_MS,
  )
  if (asked.failed) return null
  let inbox = ""
  for (let attempt = 0; attempt < 30 && inbox === ""; attempt++) {
    const checked = await call("task_inbox", {})
    if (!checked.text.startsWith("No new messages")) inbox = checked.text
    else {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 2000)
      await promise
    }
  }
  return { answer: asked.text, inbox }
}

// Asks a long question with three options (like a real agent's task_ask), with a desktop screenshot when the desktop
// can start, so the question UI can be checked by hand; then reports the answer.
const runAskProbe = async (): Promise<number> => {
  const desktop = await call("desktop_open", {})
  const asked = await call(
    "task_ask",
    {
      question:
        "Before I edit the project’s README, how should I handle the setup instructions? Choose “Keep and clarify” to " +
        "preserve the existing steps while making them easier to follow; choose “Replace with a short guide” to rewrite " +
        "them from scratch; or choose “Show me a draft” to review a proposed version before anything changes.",
      options: ["Keep and clarify", "Replace with a short guide", "Show me a draft"],
      attachScreenshot: !desktop.failed,
    },
    UNBOUNDED_CALL_MS,
  )
  await call("task_report", {
    status: asked.failed ? "failed" : "done",
    message: asked.failed ? `ask probe failed: ${asked.text}` : `You chose: ${asked.text}`,
  })
  return asked.failed ? 1 : 0
}

// Drives the thread tools: lists the owner's other threads, reads one (the named thread, or the first listed), sends
// its agent "ping" and waits in the inbox for its "pong".
const runThreadProbe = async (target: string | undefined): Promise<number> => {
  const listed = await call("thread_list", {})
  console.log(`fake-agent: thread list\n${listed.text}`)
  const threadId = target ?? /^(\S+) "/m.exec(listed.text)?.[1]
  if (listed.failed || threadId === undefined) {
    await call("task_report", { status: "failed", message: "thread probe found no other thread" })
    return 1
  }
  console.log(`fake-agent: thread read\n${(await call("thread_read", { threadId, limit: 5 })).text}`)
  const sent = await call("thread_send", { threadId, message: "ping" })
  console.log(`fake-agent: thread send failed=${sent.failed} text=${sent.text}`)
  if (sent.failed) {
    await call("task_report", { status: "failed", message: `thread probe could not send: ${sent.text}` })
    return 1
  }
  let reply = ""
  for (let attempt = 0; attempt < 30 && reply === ""; attempt++) {
    const checked = await call("task_inbox", {})
    if (!checked.text.startsWith("No new messages")) reply = checked.text
    else await sleepMs(2000)
  }
  await call("task_report", {
    status: reply === "" ? "failed" : "done",
    message: reply === "" ? `no answer from thread ${threadId}` : `Thread ${threadId} answered:\n${reply}`,
  })
  return reply === "" ? 1 : 0
}

const main = async (): Promise<number> => {
  await client.connect(transport)
  console.log(`fake-agent: connected to ${mcpUrl}`)
  // A resumed run (every run after a task's first) behaves like a fresh one; its report names the session it continued.
  if (resumeSession !== undefined) console.log(`fake-agent: resumed session ${resumeSession} with prompt: ${prompt}`)
  const resumed = resumeSession === undefined ? "" : ` Resumed session ${resumeSession}.`
  // Probes match the user's text, not the user context the box puts before it (core/user-context.ts).
  const request = prompt.startsWith("The user is signed in to Kestrel as ") ? prompt.slice(prompt.indexOf("\n\n") + 2) : prompt
  if (request.trim() === "exec-probe") return runExecProbes()
  const [probe, arg] = request.trim().split(/\s+/)
  if (probe === "automation-probe") return runAutomationProbes(arg)
  if (probe === "thread-probe") return runThreadProbe(arg)
  if (probe === "ask-probe") return runAskProbe()
  // Another agent's "ping" (sent by a thread probe) is answered with "pong" to the thread it came from.
  const ping = /^Message from the agent of .*\(thread id (\S+)\):\n\nping\n/.exec(request)
  if (ping !== null) {
    const answered = await call("thread_send", { threadId: ping[1], message: "pong" })
    await call("task_report", { status: answered.failed ? "failed" : "done", message: `answered ping: ${answered.text}` })
    return answered.failed ? 1 : 0
  }
  if (probe === "checkout-probe") return runCheckoutProbe(arg ?? "")
  if (probe === "toolkit-probe") return runToolkitProbe(arg ?? "", request.trim().split(/\s+/).slice(2).join(" "))
  if (request.trim() === "desktop-probe") return runDesktopProbes()

  // The desktop starts only when the agent opens it: until then the desktop tools refuse.
  await call("desktop_screenshot", {})

  const encoded = Buffer.from(prompt, "utf8").toString("base64")
  const write = await call("workspace_exec", {
    command: `printf '%s' '${encoded}' | base64 -d > AGENT_NOTES.md`,
  })
  if (write.failed || !write.text.startsWith("exit code: 0")) {
    await call("task_report", { status: "failed", message: "fake agent could not write AGENT_NOTES.md" })
    return 1
  }

  // Prompts that mention "ask" exercise task_ask (with options and a screenshot) and task_inbox.
  if (/\bask\b/i.test(prompt)) {
    const outcome = await askAndListen()
    if (outcome === null) {
      await call("task_report", { status: "failed", message: "fake agent question was not answered" })
      return 1
    }
    await call("task_report", {
      status: "done",
      message: `Answer: ${outcome.answer}. Inbox: ${outcome.inbox || "empty"}`,
    })
    return 0
  }

  await call("task_report", {
    status: "done",
    message: `Wrote AGENT_NOTES.md from the prompt.${choice === "" ? "" : ` (${choice})`}${resumed}`,
  })
  return 0
}

const run = async (): Promise<number> => {
  try {
    const code = await main()
    await client.close()
    return code
  } catch (e) {
    console.error(`fake-agent: failed: ${e instanceof Error ? e.message : String(e)}`)
    await client.close().catch(() => undefined)
    return 1
  }
}

/** The app-server side of a Codex run: one thread, one turn, played by `main`. Exits when the harness closes stdin. */
const serveAppServer = () => {
  const send = (message: unknown) => console.log(JSON.stringify(message))
  const turnId = randomUUID()
  let threadId = ""
  let turnOver = false
  const endTurn = (status: "completed" | "failed" | "interrupted") => {
    if (turnOver) return
    turnOver = true
    const error = status === "failed" ? { message: "fake agent failed" } : null
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], status, error, durationMs: null } } })
  }
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (message.id === undefined) return
      const params = message.params ?? {}
      switch (message.method) {
        case "initialize":
          send({ id: message.id, result: { userAgent: "kestrel-fake-agent" } })
          return
        case "account/login/start":
          send({ id: message.id, result: { type: "apiKey" } })
          return
        case "thread/start":
        case "thread/resume": {
          threadId = message.method === "thread/resume" ? String(params.threadId) : randomUUID()
          if (message.method === "thread/resume") resumeSession = threadId
          send({ id: message.id, result: { thread: { id: threadId }, model: model ?? null } })
          return
        }
        case "turn/start": {
          const input = Array.isArray(params.input) ? (params.input[0] as { text?: string } | undefined) : undefined
          prompt = input?.text ?? ""
          send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } })
          send({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } } })
          void run().then((code) => endTurn(code === 0 ? "completed" : "failed"))
          return
        }
        case "turn/steer": {
          const input = Array.isArray(params.input) ? (params.input[0] as { text?: string } | undefined) : undefined
          console.log(`fake-agent: steered with: ${input?.text ?? ""}`)
          send({ id: message.id, result: { turnId } })
          return
        }
        case "turn/interrupt":
          send({ id: message.id, result: {} })
          endTurn("interrupted")
          return
        default:
          send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported by the fake agent` } })
      }
    })
    .on("close", () => process.exit(0))
}

if (appServer) serveAppServer()
else process.exit(await run())

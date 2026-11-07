/**
 * Deterministic stand-in for the agent harness (CLOUDAGENTS_FAKE_AGENT=1).
 * Runs where a real agent would (the thread's first checkout, else its workspace) and talks to the task's MCP
 * endpoint like a real agent would. Like the real CLIs it takes its prompt on stdin: Claude Code's stream-json input
 * for Anthropic models, Codex app-server's JSON-RPC for OpenAI ones, the Agent Client Protocol for OpenCode's, and
 * plays one turn.
 */
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

const mcpUrl = process.env.CLOUDAGENTS_MCP_URL
const mcpToken = process.env.CLOUDAGENTS_MCP_TOKEN
let prompt = ""
const model = process.env.CLOUDAGENTS_MODEL
const effort = process.env.CLOUDAGENTS_EFFORT
const choice = [model === undefined ? null : `model: ${model}`, effort === undefined ? null : `effort: ${effort}`]
  .filter((part): part is string => part !== null)
  .join(", ")

// Isolated text generation (thread titles): no MCP session, no thread files. The prompt is the whole stdin, and the
// answer is one line, so the smoke test exercises the real spawn, credential and cleanup path without a model key.
if (process.env.CLOUDAGENTS_TEXT_GENERATION === "1") {
  const input = readFileSync(0, "utf8")
  const source = /The user's first message:\s*"""\n([\s\S]*?)\n"""/.exec(input)?.[1] ?? ""
  const title = source.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ")
  console.log(title === "" ? "Fake generated title" : title)
  process.exit(0)
}

if (!mcpUrl || !mcpToken) {
  console.error("fake-agent: CLOUDAGENTS_MCP_URL or CLOUDAGENTS_MCP_TOKEN is not set")
  process.exit(1)
}

// The run tells the script which protocol its route actually uses. Model ids are no longer enough (a gateway model
// may run through Claude Code, Codex or OpenCode), so CLOUDAGENTS_HARNESS wins and old callers fall back to the prefix.
const harness = process.env.CLOUDAGENTS_HARNESS
const appServer =
  harness === "codex" || (harness === undefined && model?.startsWith("gpt-") === true)
const acp =
  harness === "opencode" ||
  harness === "antigravity" ||
  (harness === undefined && (/^opencode(-go)?\//.test(model ?? "") || model?.startsWith("gemini-") === true))
// A Claude run's first line names its session in Claude Code's stream-json init; a Codex run's thread is named in its
// `thread/start` or `thread/resume` response, an ACP run's session in `session/new` (or the one `session/resume` names).
// A resumed run keeps its session.
let resumeSession = appServer || acp ? undefined : process.env.CLOUDAGENTS_RESUME_SESSION
if (!appServer && !acp) {
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

// Runs `gh <command>` through the shell, as an agent's shell tool would, and reports what it printed and its exit code.
const runGhProbe = async (command: string): Promise<number> => {
  const result = spawnSync("sh", ["-c", `gh ${command}`], { encoding: "utf8" })
  const message = `gh ${command}\nexit: ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  console.log(`fake-agent: probe ${message}`)
  await call("task_report", { status: result.status === 0 ? "done" : "failed", message })
  return 0
}

// No model key is configured by the listener smoke test: 424 proves that the run token reached the broker and
// passed authentication, without making a provider request. Never log the URL: it contains the run token.
// `listener-probe <publicPort> <hostPort> <expect>`: with `unreachable` (strict networking), the sandbox's own loopback
// must not reach the box's public port or another host loopback service (curl prints 000 when nothing listens).
const runListenerProbe = async (publicPort?: string, hostPort?: string, expect?: string): Promise<number> => {
  const base = process.env.ANTHROPIC_BASE_URL
  if (base === undefined) throw new Error("listener probe requires ANTHROPIC_BASE_URL")
  const response = await fetch(`${base}/v1/models`)
  const body = await response.json() as { _tag?: string }
  if (response.status !== 424 || body._tag !== "MissingCredential") {
    throw new Error(`listener probe: broker answered ${response.status}`)
  }
  const exec = await call("workspace_exec", { command: "echo listener-probe-ok" })
  if (exec.failed || !exec.text.startsWith("exit code: 0") || !exec.text.includes("listener-probe-ok")) {
    throw new Error("listener probe: workspace_exec failed")
  }
  if (expect === "unreachable" && publicPort !== undefined && hostPort !== undefined) {
    for (const port of [publicPort, hostPort]) {
      const probe = await call("workspace_exec", {
        command: `curl -s -m 3 -o /dev/null -w 'code=%{http_code}' http://127.0.0.1:${port}/ ; true`,
      })
      if (!probe.text.includes("code=000")) throw new Error(`listener probe: host loopback port ${port} reachable from sandbox`)
    }
  }
  await call("task_report", { status: "done", message: "listener probe: MCP, broker and workspace exec passed" })
  return 0
}

// Checks `repo` out into the thread, commits one file in the checkout and leaves another uncommitted, so the diff
// must show both. Reports the checkout's directory, the directory the run started in and what repo_checkout said.
const runCheckoutProbe = async (repo: string): Promise<number> => {
  const checkout = await call("repo_checkout", { repo })
  const dir = /\bat (\S+) \(/.exec(checkout.text)?.[1]
  if (checkout.failed || dir === undefined) {
    await call("task_report", { status: "failed", message: `fake agent could not check out ${repo}` })
    return 1
  }
  const committed = await call("workspace_exec", {
    // Appends, so a later run of the probe in the same thread has a change to commit too.
    command: `cd '${dir}' && echo committed >> CHECKOUT_PROBE.txt && git add CHECKOUT_PROBE.txt && git -c user.name=fake -c user.email=fake@example.com commit -qm "checkout probe"`,
  })
  const uncommitted = await call("workspace_exec", { command: `cd '${dir}' && echo uncommitted > UNCOMMITTED_PROBE.txt` })
  if (!committed.text.startsWith("exit code: 0") || !uncommitted.text.startsWith("exit code: 0")) {
    await call("task_report", { status: "failed", message: `fake agent could not change files in ${dir}` })
    return 1
  }
  await call("task_report", {
    status: "done",
    message: `checkout probe finished in ${dir}; run started in ${process.cwd()}; repo_checkout said: ${checkout.text}`,
  })
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
  const listener = /^listener-probe(?: (\d+) (\d+) (\S+))?$/.exec(request.trim())
  if (listener !== null) return runListenerProbe(listener[1], listener[2], listener[3])
  const [probe, arg] = request.trim().split(/\s+/)
  if (probe === "automation-probe") return runAutomationProbes(arg)
  if (probe === "thread-probe") return runThreadProbe(arg)
  if (probe === "gh-probe") return runGhProbe(request.trim().split(/\s+/).slice(1).join(" ") || "--version")
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

/** The ACP side of an OpenCode run: one session, one prompt, played by `main`. Exits when the harness closes stdin. */
const serveAcp = () => {
  const send = (message: Record<string, unknown>) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
  let sessionId = ""
  let promptId: number | null = null
  const endTurn = (stopReason: "end_turn" | "cancelled" | "refusal") => {
    if (promptId === null) return
    send({ id: promptId, result: { stopReason } })
    promptId = null
  }
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
      const params = message.params ?? {}
      if (message.method === "session/cancel") {
        endTurn("cancelled")
        return
      }
      if (message.id === undefined) return
      switch (message.method) {
        case "initialize":
          send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
          return
        case "session/new":
        case "session/resume": {
          sessionId = message.method === "session/resume" ? String(params.sessionId) : randomUUID()
          if (message.method === "session/resume") resumeSession = sessionId
          const configOptions = [{ id: "model", type: "select", currentValue: model ?? "", options: [] }]
          send({ id: message.id, result: message.method === "session/new" ? { sessionId, configOptions } : { configOptions } })
          return
        }
        case "session/set_config_option":
          send({ id: message.id, result: { configOptions: [{ id: "model", type: "select", currentValue: model ?? "", options: [] }] } })
          return
        case "session/prompt": {
          const block = Array.isArray(params.prompt) ? (params.prompt[0] as { text?: string } | undefined) : undefined
          prompt = block?.text ?? ""
          promptId = message.id
          void run().then((code) => endTurn(code === 0 ? "end_turn" : "refusal"))
          return
        }
        default:
          send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported by the fake agent` } })
      }
    })
    .on("close", () => process.exit(0))
}

/** The Claude Code side of a run: the first stream-json user message is the prompt; later ones steer the turn. */
const serveClaude = () => {
  const send = (message: unknown) => console.log(JSON.stringify(message))
  let started = false
  let turnOver = false
  let exitCode = 0
  const endTurn = (code: number, interrupted = false) => {
    if (turnOver) return
    turnOver = true
    exitCode = code
    if (interrupted) send({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    send({ type: "result", subtype: code === 0 ? "success" : "error_during_execution", is_error: code !== 0 })
  }
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = JSON.parse(line) as { type?: string; request_id?: string; message?: { content?: unknown } }
      if (message.type === "control_request") {
        send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })
        endTurn(1, true)
        return
      }
      if (message.type !== "user") return
      const text = typeof message.message?.content === "string" ? message.message.content : ""
      if (started) {
        console.log(`fake-agent: steered with: ${text}`)
        return
      }
      started = true
      prompt = text
      void run().then((code) => endTurn(code))
    })
    .on("close", () => process.exit(exitCode))
}

if (appServer) serveAppServer()
else if (acp) serveAcp()
else serveClaude()

/**
 * Deterministic stand-in for the agent harness (CLOUDAGENTS_FAKE_AGENT=1).
 * Runs with cwd = task worktree and talks to the task's MCP endpoint like a real agent would.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

const mcpUrl = process.env.CLOUDAGENTS_MCP_URL
const mcpToken = process.env.CLOUDAGENTS_MCP_TOKEN
const prompt = process.env.CLOUDAGENTS_PROMPT ?? ""

if (!mcpUrl || !mcpToken) {
  console.error("fake-agent: CLOUDAGENTS_MCP_URL or CLOUDAGENTS_MCP_TOKEN is not set")
  process.exit(1)
}

const client = new Client({ name: "cloudagents-fake-agent", version: "0.1.0" })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } },
})

const call = async (name: string, args: Record<string, unknown>): Promise<{ failed: boolean; text: string }> => {
  console.log(`fake-agent: call ${name} ${JSON.stringify(args).slice(0, 200)}`)
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
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

const sleepMs = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

// Drives the desktop tools against a live desktop: an xterm to type into, and a ticking app for output.
const runDesktopProbes = async (): Promise<number> => {
  await call("desktop_screenshot", {})
  const term = await call("desktop_launch", { command: "xterm -geometry 100x30+40+40 -e bash" })
  const ticker = await call("desktop_launch", {
    command: "sh -c 'echo probe-started; i=0; while :; do i=$((i+1)); echo tick-$i; sleep 1; done'",
  })
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

const main = async (): Promise<number> => {
  await client.connect(transport)
  console.log(`fake-agent: connected to ${mcpUrl}`)
  if (prompt.trim() === "exec-probe") return runExecProbes()
  if (prompt.trim() === "desktop-probe") return runDesktopProbes()

  // Screenshot is best-effort: the desktop may not be running.
  await call("desktop_screenshot", {})

  const encoded = Buffer.from(prompt, "utf8").toString("base64")
  const write = await call("workspace_exec", {
    command: `printf '%s' '${encoded}' | base64 -d > AGENT_NOTES.md`,
  })
  if (write.failed || !write.text.startsWith("exit code: 0")) {
    await call("task_report", { status: "failed", message: "fake agent could not write AGENT_NOTES.md" })
    return 1
  }

  await call("task_report", { status: "done", message: "Wrote AGENT_NOTES.md from the prompt." })
  return 0
}

try {
  const code = await main()
  await client.close()
  process.exit(code)
} catch (e) {
  console.error(`fake-agent: failed: ${e instanceof Error ? e.message : String(e)}`)
  await client.close().catch(() => undefined)
  process.exit(1)
}

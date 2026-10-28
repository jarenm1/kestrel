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

const main = async (): Promise<number> => {
  await client.connect(transport)
  console.log(`fake-agent: connected to ${mcpUrl}`)

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

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ToolFailureReport } from "@cloudagents/protocol"
import { agentFailure, declinedCodexItem, endsCodexTurn, failureSignature, makeToolFailureReporter, toolFailure } from "./tool-failures"

describe("failureSignature", () => {
  test("does not scrub oversized output or leak a truncated secret", () => {
    expect(failureSignature("Read", `error: '${"x".repeat(200_000)}'`)).toBe("(output too large)")
  })
  test("failures that differ only in their details share a signature", () => {
    const a = failureSignature("Read", "File does not exist: /home/jaren/app/src/a.ts")
    const b = failureSignature("Read", "File does not exist: /tmp/other/b.tsx")
    expect(a).toBe("File does not exist: <path>")
    expect(b).toBe(a)
  })

  test.each([
    ["a home path", "Error: cannot read /home/alice/secret-project/plan.md", "alice"],
    ["a relative path", "cannot open customers/acme/invoice.pdf", "acme"],
    ["a url with credentials", "fatal: unable to access https://user:hunter2@github.com/acme/repo.git", "hunter2"],
    ["an email", "error: no account for alice@example.com", "alice"],
    ["a quoted value", "error: unknown customer 'Acme Corp'", "Acme"],
    ["an assignment", "invalid setting DATABASE_URL=postgres://u:p@host/db", "postgres"],
    ["a named secret", "request failed: api_key: hunter2", "hunter2"],
    ["a bearer token", "error sending Authorization: Bearer abcdef", "abcdef"],
    ["a long token", "invalid token ghp_0123456789abcdefghijklmnopqrstuvwxyz", "ghp_"],
    ["a bare token without digits", "failed with abcdefghijklmnopqrstuvwxyzABCDEF", "abcdefghij"],
    ["a file name", "failed to parse payroll.xlsx at line 4", "payroll"],
    ["a commit id", "error: bad object 3f9a1c2", "3f9a1c2"],
  ])("scrubs %s", (_name, output, leaked) => {
    expect(failureSignature("Read", output)).not.toContain(leaked)
  })

  test("names the error line, not the output around it", () => {
    const output = "Exit code 2\nCompiling 14 files\nsrc/a.ts:3:1 - error TS2304: Cannot find name 'x'.\n1 error"
    expect(failureSignature("Bash", output)).toBe("<path> - error <id>: Cannot find name <str>.")
  })

  test("shell output with no error line stays out of the signature", () => {
    expect(failureSignature("Bash", "Exit code 1\nmy private note about a merger")).toBe("exit code 1")
    expect(failureSignature("command_execution", "my private note about a merger")).toBe("(no error line)")
  })

  test("another tool's first line stands in for its error", () => {
    expect(failureSignature("mcp__cloudagents__desktop_click", "desktop is stopped")).toBe("desktop is stopped")
  })

  test("drops colour codes and Claude's error tags, and cuts long lines", () => {
    expect(failureSignature("Edit", "<tool_use_error>\u001b[31mString not found in file</tool_use_error>")).toBe("String not found in file")
    expect(failureSignature("Read", `error ${"word ".repeat(100)}`).length).toBeLessThanOrEqual(200)
  })

  test("no output at all", () => {
    expect(failureSignature("file_change", null)).toBe("(no output)")
  })
})

describe("agentFailure", () => {
  test("classifies early exits for both agents without sending error text", () => {
    expect(agentFailure("claude", "Claude Code exited before its turn finished.")).toEqual({ tool: "agent:claude", signature: "exited before turn finished" })
    expect(agentFailure("codex", "Codex exited before its turn finished.")).toEqual({ tool: "agent:codex", signature: "exited before turn finished" })
    expect(agentFailure("codex", "private provider error")).toEqual({ tool: "agent:codex", signature: "turn failed" })
    expect(agentFailure("claude", null).signature).toBe("turn failed")
  })
})

describe("toolFailure", () => {
  test("recognizes a declined Codex completion without suppressing other items", () => {
    const message = { method: "item/completed", params: { item: { id: "c1", type: "fileChange", status: "declined" } } }
    expect(declinedCodexItem(message, "c1")).toBe(true)
    expect(declinedCodexItem(message, "c2")).toBe(false)
    expect(declinedCodexItem({ ...message, method: "item/started" }, "c1")).toBe(false)
  })
  test("a Codex turn's end is recognized, so the commands it closes are not counted", () => {
    expect(endsCodexTurn({ method: "turn/completed", params: {} })).toBe(true)
    expect(endsCodexTurn({ method: "item/completed", params: {} })).toBe(false)
  })
  test("a call the user stopped or declined is not a failure", () => {
    expect(toolFailure("Bash", "[Request interrupted by user for tool use]")).toBeNull()
    expect(toolFailure("Edit", "The user doesn't want to proceed with this tool use. The tool use was rejected.")).toBeNull()
  })

  test("hides other MCP servers' names and keeps Kestrel's", () => {
    expect(toolFailure("mcp__acme-internal__lookup", "boom")?.tool).toBe("mcp__other")
    expect(toolFailure("acme-internal.lookup", "boom")?.tool).toBe("mcp.other")
    expect(toolFailure("mcp__cloudagents__repo_checkout", "boom")?.tool).toBe("mcp__cloudagents__repo_checkout")
    expect(toolFailure("cloudagents.repo_checkout", "boom")?.tool).toBe("cloudagents.repo_checkout")
    expect(toolFailure("Bash", null)?.tool).toBe("Bash")
  })

  test("another MCP server's output counts only when a line looks like an error", () => {
    expect(toolFailure("mcp__acme-internal__lookup", "customer lookup broke")?.signature).toBe("(no error line)")
    expect(toolFailure("acme-internal.lookup", "request failed")?.signature).toBe("request failed")
  })

  test("a url inside quotes leaves no stray quote behind", () => {
    expect(toolFailure("Bash", "fatal: unable to access 'https://user:hunter2@github.com/acme/repo.git/'")?.signature).toBe(
      "fatal: unable to access <str>",
    )
  })

  test("Kestrel's exec tool is treated as a shell on both harnesses", () => {
    expect(toolFailure("mcp__cloudagents__workspace_exec", "private note")?.signature).toBe("(no error line)")
    expect(toolFailure("cloudagents.workspace_exec", "private note")?.signature).toBe("(no error line)")
  })
})

describe("makeToolFailureReporter", () => {
  const recording = () => {
    const reports: ToolFailureReport[] = []
    return { reports, send: (report: ToolFailureReport) => Effect.sync(() => void reports.push(report)) }
  }

  test("sends counts together after the interval", async () => {
    const { reports, send } = recording()
    const reporter = makeToolFailureReporter(send, 5)
    reporter.record({ tool: "Bash", signature: "a" })
    reporter.record({ tool: "Bash", signature: "a" })
    reporter.record({ tool: "Read", signature: "a" })
    expect(reports).toEqual([])
    await Bun.sleep(30)
    expect(reports).toEqual([
      {
        failures: [
          { tool: "Bash", signature: "a", count: 2 },
          { tool: "Read", signature: "a", count: 1 },
        ],
      },
    ])
  })

  test("flush sends at once and leaves nothing behind", async () => {
    const { reports, send } = recording()
    const reporter = makeToolFailureReporter(send, 5)
    reporter.record({ tool: "Bash", signature: "a" })
    await Effect.runPromise(reporter.flush)
    await Effect.runPromise(reporter.flush)
    await Bun.sleep(20)
    expect(reports.length).toBe(1)
  })

  test("a report stays within the schema's limit, and known failures keep counting past it", async () => {
    const { reports, send } = recording()
    const reporter = makeToolFailureReporter(send, 60_000)
    for (let i = 0; i < 250; i++) reporter.record({ tool: "Bash", signature: `s${i}` })
    reporter.record({ tool: "Bash", signature: "s0" })
    await Effect.runPromise(reporter.flush)
    expect(reports[0]?.failures.length).toBe(200)
    expect(reports[0]?.failures[0]?.count).toBe(2)
  })

  test("a failed report is dropped and never fails the flush", async () => {
    const reporter = makeToolFailureReporter(() => Effect.fail({ message: "control plane unreachable" }), 60_000)
    reporter.record({ tool: "Bash", signature: "a" })
    await Effect.runPromise(reporter.flush)
  })
})

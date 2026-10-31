# Agent replay fixtures

Each file is the exact JSONL stdout of one agent run: one line is one line the CLI prints (for Codex, app-server's
JSON-RPC responses and notifications). The dev-only
`/replay <harness>/<name>` chat command pipes the file through `scripts/replay-agent.ts`, so the box sees it
as a normal harness subprocess and the real pipeline (harness → events → WebSocket → app) runs unchanged.
No UI mocks.

Names are `^[a-z0-9-]+$`; harness directories are `claude/` and `codex/`.

## Fixtures

| File | Source | What it exercises |
|---|---|---|
| `claude/markdown` | hand-made | init, thinking block, one long markdown answer (headings, lists, table, TS/Python/Bash/JSON code, inline SVG, raw `<details>`/`<table>` HTML, mermaid, links, long lines), result usage/cost/duration and `modelUsage.contextWindow` (every `claude/` result carries it, so a replay fills the composer's context bar) |
| `claude/tools` | hand-made | thinking, Bash/Read/Grep/Edit/Write calls, parallel Read+Grep (two lines, same `message.id`, one user line with both results), `is_error: true` tool result, MCP `mcp__cloudagents__desktop_screenshot` returning an image block, Task subagent with `parent_tool_use_id` on its assistant/user lines, multiple text messages between tools, result |
| `claude/long` | hand-made | 66 lines / 20 tool cycles: scrolling, incremental item updates and streaming performance |
| `claude/error` | hand-made | failing tool result, then a `result` with `subtype: "error_during_execution"`, `is_error: true` and no `result` text |
| `claude/recorded-streaming` | real recording | `stream_event` partial messages (`--include-partial-messages`): a streamed `tool_use`, a Bash result, then a text block streamed in deltas before its finished `assistant` line, and a result with usage |
| `codex/recorded-shell` | real recording | streamed `agentMessage`s (`item/agentMessage/delta`), a `commandExecution` that succeeds and one that exits 1, a final markdown answer with a table, a TS block and inline SVG, `thread/tokenUsage/updated` (fills the context bar) |
| `codex/recorded-edit` | real recording | `fileChange` add + update, `turn/diff/updated`, `commandExecution`s, a final markdown answer with a mermaid block and `<details>` |
| `codex/kitchen-sink` | hand-made | reasoning with a summary delta, several streamed `agentMessage`s, `turn/plan/updated` as a todo list, `commandExecution` output deltas, success and exit 2, `fileChange`, `mcpToolCall` to `cloudagents` (`workspace_exec`, `desktop_screenshot` success with an image block, `desktop_screenshot` failure with `error.message`), `webSearch`, and a final markdown answer with the full rendering matrix |
| `codex/failed-turn` | hand-made | a failed `commandExecution`, a top-level `error`, `turn/completed` with status `failed` and the same error |

The two `codex/recorded-*` files are the stdout of real `codex app-server` turns (codex-cli 0.163.0, the flake's),
without the account, rate-limit and MCP start-up lines, with paths rewritten to `/home/agent/...`: structure, item
ids and event order are exactly as recorded. The hand-made ones follow the same app-server shapes.

`claude/recorded-streaming` is the stdout of a real Claude Code run (2.1.312) with the harness's flags, without
the hook, status and rate-limit lines, with `init` trimmed to its session, model and built-in tools, and paths
rewritten to `/home/agent/...`. The other four `claude/` files are **hand-made** from the documented
`stream-json --verbose` shapes, without partial messages (each assistant line carries one content block; content
blocks of the same API message share `message.id`; `session_id`/`uuid` are consistent within a file).

## Recording new fixtures

Record on Linux, where the box runs, and use the same CLI flags as the harness
(`packages/server/src/config.ts`):

```sh
# Claude: one content block per assistant line, with the stream_event deltas the harness streams from.
claude -p 'your prompt' \
  --mcp-config "$CLOUDAGENTS_MCP_CONFIG" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose --include-partial-messages \
  > packages/server/fixtures/agent/claude/<name>.jsonl

# Codex: a box run's output.log holds app-server's JSON lines, its stderr log and the box's requests (`>> `).
grep '^{' "$CLOUDAGENTS_DATA_DIR/runs/<run id>/output.log" \
  > packages/server/fixtures/agent/codex/<name>.jsonl
```

Give the prompt a task that covers the display you want to build. Before committing a recording, sanitize it:
replace absolute paths with `/home/agent/work/...`, strip personal data and API keys, and use a fresh UUID for
`thread_id`/`session_id`. Keep every line valid single-line JSON with the real field names, nesting and types.

## Using a fixture

1. Run the dev stack and sign in at `/auth/dev-login` (fixture replay is dev-only; the relay marks dev-login
   sessions so the box accepts it).
2. Open a task chat and send `/replay claude/markdown` (or `codex/kitchen-sink`, etc.).
3. The run appears like any other run; `RunPanel` keeps showing the raw log while the chat shows the items.

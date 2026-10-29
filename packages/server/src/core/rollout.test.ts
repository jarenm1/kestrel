import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codexContext } from "./rollout"

const THREAD = "01a18576-617c-7f13-a15e-206a5e564912"

/** A `token_count` event as codex 0.160 writes it: running session totals plus the latest call alone. */
const tokenCount = (total: number, last: number, window = 258_400) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total, output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: last - 50, output_tokens: 50, total_tokens: last },
        model_context_window: window,
      },
    },
  })
const turnContext = (model: string) => JSON.stringify({ type: "turn_context", payload: { cwd: "/home/agent/work", model } })
const compacted = JSON.stringify({ type: "compacted", payload: { message: "", replacement_history: [] } })

describe("codexContext", () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kestrel-rollout-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const writeRollout = async (day: string, thread: string, lines: ReadonlyArray<string>) => {
    const dir = join(home, "sessions", "2026", "10", day)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `rollout-2026-10-${day}T21-21-30-${thread}.jsonl`), `${lines.join("\n")}\n`)
  }

  test("the latest call of a resumed session, not the cumulative totals exec reports", async () => {
    await writeRollout("27", "01a00000-0000-7000-8000-000000000000", [turnContext("gpt-6-luna"), tokenCount(1, 1)])
    await writeRollout("28", THREAD, [
      turnContext("gpt-6-sol"),
      tokenCount(14_570, 14_570),
      turnContext("gpt-6.1-sol"),
      tokenCount(29_948, 15_378, 400_000),
      tokenCount(45_370, 15_422, 400_000),
    ])
    expect(await codexContext(home, THREAD)).toEqual({ model: "gpt-6.1-sol", usedTokens: 15_422, windowTokens: 400_000 })
  })

  test("after a compaction, the next call's size; none until it", async () => {
    await writeRollout("28", THREAD, [turnContext("gpt-6-sol"), tokenCount(240_000, 240_000), compacted])
    expect(await codexContext(home, THREAD)).toBeNull()
    await writeRollout("28", THREAD, [turnContext("gpt-6-sol"), tokenCount(240_000, 240_000), compacted, tokenCount(260_000, 20_000)])
    expect(await codexContext(home, THREAD)).toEqual({ model: "gpt-6-sol", usedTokens: 20_000, windowTokens: 258_400 })
  })

  test("no rollout for the thread", async () => {
    expect(await codexContext(home, THREAD)).toBeNull()
  })
})

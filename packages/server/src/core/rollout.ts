import { open, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { ContextUsage } from "@cloudagents/protocol"
import { asNumber, isRecord } from "./transcript"

/**
 * `codex exec --json` reports only session-cumulative token totals, so a codex session's context use comes from
 * its rollout, `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`: every model call appends
 * a `token_count` event with that call's usage (`last_token_usage`) and the window (`model_context_window`), and
 * each turn opens with a `turn_context` naming the model. A resumed session appends to the same file.
 */

/** Enough of the file's end to hold the latest turn's events; compactions write single lines of several MB. */
const TAIL_BYTES = 8 * 1024 * 1024

const newestFirst = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).sort().reverse()

/** The thread's rollout file, searching the newest days first; null when codex wrote none. */
const findRollout = async (codexHome: string, threadId: string): Promise<string | null> => {
  const suffix = `-${threadId}.jsonl`
  const root = join(codexHome, "sessions")
  for (const year of await newestFirst(root)) {
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        const dir = join(root, year, month, day)
        const file = (await readdir(dir).catch(() => [] as string[])).find(
          (name) => name.startsWith("rollout-") && name.endsWith(suffix),
        )
        if (file !== undefined) return join(dir, file)
      }
    }
  }
  return null
}

/** Context use after the last model call among rollout `lines` (oldest first), or null when none follows the last compaction. */
export const contextFromRollout = (lines: ReadonlyArray<string>): ContextUsage | null => {
  let model: string | null = null
  let latest: { readonly usedTokens: number; readonly windowTokens: number } | null = null
  for (const line of lines) {
    // Most lines are transcript content; skip them unparsed.
    if (!line.includes("token_count") && !line.includes("turn_context") && !line.includes('"compacted"')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(event) || !isRecord(event.payload)) continue
    const payload = event.payload
    if (event.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model
    } else if (event.type === "compacted") {
      latest = null
    } else if (event.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
      const last = isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : null
      const used = last === null ? null : asNumber(last.total_tokens)
      const window = asNumber(payload.info.model_context_window)
      if (used !== null && window !== null && window > 0) latest = { usedTokens: used, windowTokens: window }
    }
  }
  return latest === null ? null : { model, ...latest }
}

/** The codex session's context use from its rollout under `codexHome` (host path); null when it cannot tell. */
export const codexContext = async (codexHome: string, threadId: string): Promise<ContextUsage | null> => {
  const path = await findRollout(codexHome, threadId)
  if (path === null) return null
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString("utf8").split("\n")
    // A tail that starts mid-file starts mid-line.
    if (start > 0) lines.shift()
    return contextFromRollout(lines)
  } finally {
    await handle.close()
  }
}

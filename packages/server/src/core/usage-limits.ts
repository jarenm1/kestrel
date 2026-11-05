import type { CliProvider, ModelProvider, ProviderUsage } from "@cloudagents/protocol"

/**
 * The text of a run that failed on its provider's usage limit, and when that provider will allow work again.
 *
 * A failed run's evidence is its error items plus the agent message it left behind (Claude Code puts the limit text in
 * its result, not in an error item). The reset comes from the provider's own usage report, whose exhausted window is at
 * 100% and names its reset: Kestrel does not guess a time from the error prose.
 */

/** Provider whose usage the harness's model runs on, when the box can read its limits. */
export const MODEL_USAGE_CLI: Partial<Record<ModelProvider, CliProvider>> = {
  anthropic: "claude-cli",
  openai: "codex-cli",
  "opencode-go": "opencode-go",
}

const USAGE_LIMIT =
  /\b(?:usage|rate|quota|weekly|monthly|daily)[ -]?(?:limit|limits)\b|\bquota (?:has been )?(?:reached|exceeded)\b|\binsufficient[ _]quota\b|\bcredit balance\b|\breached (?:your|the) limit\b|\bout of credits?\b|\btoo many requests\b|\b429\b|\blimit (?:has been )?(?:reached|exceeded)\b/i

/** Whether any of a failed run's texts says the provider refused it for a usage limit (not for another error). */
export const isUsageLimitFailure = (texts: readonly string[]): boolean => texts.some((text) => USAGE_LIMIT.test(text))

/**
 * The first moment no exhausted window is exhausted any more, or null when the provider reports no exhausted window,
 * omits a reset, or reports one at or before `notBefore` (an already-reset window must not start a retry loop).
 */
export const usageLimitResetAt = (usage: ProviderUsage | undefined, notBefore: number): string | null => {
  if (usage?.status !== "ok") return null
  const exhausted = usage.windows.filter((window) => window.usedPercent >= 100)
  if (exhausted.length === 0) return null
  const resets = exhausted.map((window) => (window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt)))
  if (resets.some((at) => Number.isNaN(at))) return null
  const at = Math.max(...resets)
  return at > notBefore ? new Date(at).toISOString() : null
}

/** The message an auto-resumed run starts with, as t3code's limit recovery does. */
export const USAGE_LIMIT_RESUME_MESSAGE = "Continue where you left off."

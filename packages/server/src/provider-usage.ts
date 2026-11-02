import type { CliProvider, ProviderUsage, ProviderUsageWindow } from "@cloudagents/protocol"
import { VERSION } from "./config"
import { discover, type DiscoveryLaunch } from "./harness-commands"

/*
 * The subscription limits of a signed-in agent CLI, as the CLI itself reports them: Claude Code answers a `get_usage`
 * control request on its stream-json interface, Codex answers `account/rateLimits/read` over app-server. The CLI reads
 * and refreshes its own login, so no token is read here. Neither call starts a model turn.
 */

const TIMEOUT_MS = 15_000
const HOUR_MINS = 60
const WEEK_MINS = 7 * 24 * HOUR_MINS
const MONTH_MINS = 30 * 24 * HOUR_MINS
const LABEL_MAX = 80
/** Codex's refusal when no account is signed in; every other error means it could not answer. */
const CODEX_SIGNED_OUT = /authentication required/i

type Fields = Record<string, unknown>

const fields = (value: unknown): Fields | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

const percent = (value: number): number => Math.min(100, Math.max(0, value))

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LABEL_MAX)
  return cleaned === "" ? null : cleaned
}

const isoFromString = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

const isoFromEpochSeconds = (value: unknown): string | null => {
  const seconds = finite(value)
  return seconds === null || seconds <= 0 ? null : new Date(seconds * 1000).toISOString()
}

const signedOut = (provider: CliProvider): ProviderUsage => ({ provider, status: "signed_out", plan: null, windows: [] })

const claudeWindow = (id: string, label: string, value: unknown): ProviderUsageWindow | null => {
  const window = fields(value)
  const used = finite(window?.utilization)
  return used === null ? null : { id, label, usedPercent: percent(used), resetsAt: isoFromString(window?.resets_at) }
}

/** Parses Claude Code's `get_usage` response, whose utilizations are already 0-100. API keys have no limits to report. */
export const parseClaudeUsage = (value: unknown): ProviderUsage => {
  const response = fields(value)
  const limits = fields(response?.rate_limits)
  if (response?.rate_limits_available !== true || limits === null) return signedOut("claude-cli")
  const extra = fields(limits.extra_usage)
  const windows = [
    claudeWindow("five_hour", "5-hour", limits.five_hour),
    claudeWindow("seven_day", "Weekly", limits.seven_day),
    extra?.is_enabled === true ? claudeWindow("extra_usage", "Extra usage", extra) : null,
  ].filter((window) => window !== null)
  return { provider: "claude-cli", status: "ok", plan: text(response.subscription_type), windows }
}

const codexLabel = (mins: number): string =>
  mins >= MONTH_MINS ? "Monthly" : mins >= WEEK_MINS ? "Weekly" : `${Math.max(1, Math.round(mins / HOUR_MINS))}-hour`

const codexWindow = (id: string, value: unknown, fallbackMins: number): ProviderUsageWindow | null => {
  const window = fields(value)
  const used = finite(window?.usedPercent)
  if (used === null) return null
  return {
    id,
    label: codexLabel(finite(window?.windowDurationMins) ?? fallbackMins),
    usedPercent: percent(used),
    resetsAt: isoFromEpochSeconds(window?.resetsAt),
  }
}

/** Parses Codex's `account/rateLimits/read` result. `primary` and `secondary` are positions, so durations come from each window. */
export const parseCodexUsage = (value: unknown): ProviderUsage => {
  const result = fields(value)
  // The `codex` entry is the account's main allowance; the others are limits of single models.
  const snapshot = fields(fields(result?.rateLimitsByLimitId)?.codex) ?? fields(result?.rateLimits)
  if (snapshot === null) return { provider: "codex-cli", status: "unavailable", plan: null, windows: [], error: "codex reported no limits" }
  const plan = text(snapshot.planType)
  const monthlyPlan = plan === "free" || plan === "go"
  const individual = fields(snapshot.individualLimit)
  const remaining = finite(individual?.remainingPercent)
  const windows = [
    codexWindow("primary", snapshot.primary, monthlyPlan ? MONTH_MINS : 5 * HOUR_MINS),
    codexWindow("secondary", snapshot.secondary, WEEK_MINS),
    remaining === null
      ? null
      : {
          id: "individual",
          label: "Monthly credit limit",
          usedPercent: percent(100 - remaining),
          resetsAt: isoFromEpochSeconds(individual?.resetsAt),
        },
  ].filter((window) => window !== null)
  return { provider: "codex-cli", status: "ok", plan, windows }
}

export const probeClaudeUsage = (launch: DiscoveryLaunch, timeoutMs = TIMEOUT_MS): Promise<ProviderUsage> => {
  const requestId = `kestrel-usage-${process.pid}-${Date.now()}`
  return discover<ProviderUsage>(launch, "claude usage", timeoutMs, (send) => {
    send({ type: "control_request", request_id: requestId, request: { subtype: "get_usage" } })
    return (message) => {
      const record = fields(message)
      const response = fields(record?.response)
      if (record?.type !== "control_response" || response?.request_id !== requestId) return undefined
      if (response.subtype !== "success") throw new Error("claude usage was refused")
      return parseClaudeUsage(response.response)
    }
  })
}

export const probeCodexUsage = (launch: DiscoveryLaunch, timeoutMs = TIMEOUT_MS): Promise<ProviderUsage> =>
  discover<ProviderUsage>(launch, "codex usage", timeoutMs, (send) => {
    const initializeId = 1
    const usageId = 2
    send({
      method: "initialize",
      id: initializeId,
      params: { clientInfo: { name: "kestrel", title: "Kestrel", version: VERSION }, capabilities: { experimentalApi: true } },
    })
    return (message) => {
      const record = fields(message)
      if (record?.id === initializeId) {
        if (record.error !== undefined) throw new Error("codex usage could not initialize")
        send({ method: "initialized", params: {} })
        send({ method: "account/rateLimits/read", id: usageId, params: null })
        return undefined
      }
      if (record?.id !== usageId) return undefined
      if (record.error === undefined) return parseCodexUsage(record.result)
      if (CODEX_SIGNED_OUT.test(String(fields(record.error)?.message))) return signedOut("codex-cli")
      throw new Error("codex usage was refused")
    }
  })

import type { AutomationTrigger, GithubAutomationEvent } from "@cloudagents/protocol"

export const EVENT_LABELS: Record<GithubAutomationEvent, string> = {
  "pull_request.opened": "Opened",
  "pull_request.reopened": "Reopened",
  "pull_request.ready_for_review": "Ready for review",
  "pull_request.synchronize": "New commits pushed",
  "pull_request.review_requested": "Review requested",
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const PREVIEW_MAX = 160

/** Comma-separated text field to a list: trims, drops empties. */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
}

/**
 * Plain-language reading of the common cron shapes (`M H * * *`, weekdays, named days, `*\/N` minutes); anything
 * else is shown as written. The server owns validation, so this never rejects.
 */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return cron
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields
  if (dom !== "*" || month !== "*") return cron

  const step = /^\*\/(\d+)$/.exec(minute)
  if (step && hour === "*" && dow === "*") return `Every ${step[1]} minutes`

  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cron
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`

  if (dow === "*") return `Daily at ${time}`
  if (dow === "1-5") return `Weekdays at ${time}`
  if (/^[0-7](,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map((d) => DAY_NAMES[Number(d) % 7] ?? d))]
    return `${days.join(", ")} at ${time}`
  }
  return cron
}

/** One line describing when an automation fires, e.g. "Weekdays at 09:00 · America/New_York". */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger._tag === "schedule") return `${describeCron(trigger.cron)} · ${trigger.timezone}`
  const parts = [`Pull requests: ${trigger.events.map((e) => EVENT_LABELS[e]).join(", ")}`]
  if (trigger.reviewers?.length) parts.push(`reviewers ${trigger.reviewers.join(", ")}`)
  if (trigger.baseBranches?.length) parts.push(`into ${trigger.baseBranches.join(", ")}`)
  if (trigger.includeDrafts) parts.push("drafts included")
  return parts.join(" · ")
}

/** Prompt collapsed to one line and shortened for the list row. */
export function promptPreview(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim()
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : line
}

/** Next fire in the viewer's local time, e.g. "Tue, Oct 27, 1:00 PM". */
export function formatNextRun(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

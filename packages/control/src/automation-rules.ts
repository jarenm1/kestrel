import type { AutomationTrigger } from "@cloudagents/protocol"
import { scheduleProblem } from "./cron"

/** Why a trigger cannot be saved for an automation whose repository is `repo` (null: none), or null when it can. */
export const triggerProblem = (trigger: AutomationTrigger, repo: string | null, now: number): string | null => {
  if (trigger._tag === "schedule") return scheduleProblem(trigger.cron, trigger.timezone, now)
  return repo === null ? "GitHub triggers need a GitHub repository" : null
}

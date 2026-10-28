import type { AutomationTrigger } from "@cloudagents/protocol"
import { scheduleProblem } from "./cron"

/**
 * GitHub "owner/name": an owner of 1-39 alphanumerics and hyphens (no leading or trailing hyphen), and a
 * repository name of 1-100 alphanumerics, "-", "_" or "." that is not "." or "..".
 */
const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/([A-Za-z0-9._-]{1,100})$/

export const isRepoSlug = (repo: string): boolean => {
  const name = REPO_SLUG.exec(repo)?.[1]
  return name !== undefined && name !== "." && name !== ".."
}

/** Why a trigger cannot be saved for an automation whose repository is `repo` (null: none), or null when it can. */
export const triggerProblem = (trigger: AutomationTrigger, repo: string | null, now: number): string | null => {
  if (trigger._tag === "schedule") return scheduleProblem(trigger.cron, trigger.timezone, now)
  return repo === null ? "GitHub triggers need a GitHub repository" : null
}

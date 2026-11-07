import { Schema } from "effect"
import { AutomationShare, type Automation } from "@cloudagents/protocol"

/** Query parameter that carries a shared automation on the import page. */
export const AUTOMATION_SHARE_PARAM = "automation"

/** The import page URL path; it stays inside the authenticated app. */
export const AUTOMATION_IMPORT_PATH = "/automations/import"

/** The automation reduced to what a recipient needs to create their own copy. */
const payload = (automation: Automation): AutomationShare => ({
  version: 1,
  name: automation.name,
  repo: automation.repo,
  prompt: automation.prompt,
  model: automation.model ?? null,
  trigger: automation.trigger,
})

/** Encodes a share payload for the `automation` query parameter. */
export const encodeAutomationShare = (automation: Automation): string =>
  encodeURIComponent(JSON.stringify(payload(automation)))

/** Link to import a copy of `automation`, resolved against the app's public origin. */
export const automationImportUrl = (origin: string, automation: Automation): string =>
  `${origin}${AUTOMATION_IMPORT_PATH}?${AUTOMATION_SHARE_PARAM}=${encodeAutomationShare(automation)}`

/**
 * Decodes the `automation` query parameter. The value is untrusted (anyone can edit a link), so every field is
 * validated by the protocol schema and anything else is treated as a broken link. `useSearchParams` has already
 * percent-decoded it.
 */
export const parseAutomationShare = (value: string | null): AutomationShare | null => {
  if (value === null || value === "") return null
  try {
    const decoded = Schema.decodeUnknownEither(AutomationShare)(JSON.parse(value))
    return decoded._tag === "Right" ? decoded.right : null
  } catch {
    return null
  }
}

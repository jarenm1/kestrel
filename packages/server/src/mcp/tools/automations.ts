import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import {
  type Automation,
  type AutomationTrigger,
  GithubAutomationEvent,
  NotFound,
} from "@cloudagents/protocol"
import { type ControlClient, ControlError } from "../../control/client"
import { type RunContext, guard, runTool, text, truncate } from "./common"

export interface AutomationToolDeps {
  readonly automations: {
    /** Null when the box runs without a control plane: automations are managed there. */
    readonly control: ControlClient | null
    readonly taskOwner: (taskId: string) => Effect.Effect<string, NotFound>
  }
}

const eventEnum = z.enum(GithubAutomationEvent.literals)
const eventList = z.tuple([eventEnum], eventEnum)

const triggerSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("schedule"),
    cron: z
      .string()
      .describe("Five fields: minute hour day-of-month month day-of-week. `0 13 * * 2` is Tuesdays at 13:00"),
    timezone: z.string().describe("IANA time zone the cron is read in, e.g. America/New_York"),
  }),
  z.object({
    _tag: z.literal("github"),
    events: eventList.describe("Pull request events that start a run, e.g. pull_request.opened"),
    reviewers: z.array(z.string()).optional().describe("Only pull requests requesting one of these reviewers"),
    baseBranches: z.array(z.string()).optional().describe("Only pull requests into one of these branches"),
    includeDrafts: z.boolean().optional().describe("Also run for draft pull requests (default false)"),
  }),
])

const describeTrigger = (trigger: AutomationTrigger): string => {
  if (trigger._tag === "schedule") return `schedule "${trigger.cron}" ${trigger.timezone}`
  const parts = [`on ${trigger.events.join(", ")}`]
  if (trigger.reviewers !== undefined) parts.push(`reviewers ${trigger.reviewers.join(", ")}`)
  if (trigger.baseBranches !== undefined) parts.push(`base ${trigger.baseBranches.join(", ")}`)
  if (trigger.includeDrafts === true) parts.push("drafts included")
  return `github ${parts.join("; ")}`
}

const formatAutomation = (automation: Automation): string =>
  [
    `${automation.id} "${automation.name}" (${automation.enabled ? "enabled" : "disabled"})`,
    `  trigger: ${describeTrigger(automation.trigger)}`,
    `  repo: ${automation.repo ?? "none"}`,
    `  next run: ${automation.nextRunAt ?? "none"}`,
    `  prompt: ${automation.prompt}`,
  ].join("\n")

export const registerAutomationTools = (server: McpServer, ctx: RunContext, deps: AutomationToolDeps): void => {
  // Automations act for the thread's owner: every automation of that user, whichever repository it names.
  const scope = Effect.gen(function* () {
    const control = deps.automations.control
    if (control === null) {
      return yield* Effect.fail(new ControlError({ message: "automations need the control plane; this box has none" }))
    }
    const owner = yield* deps.automations.taskOwner(ctx.taskId)
    return { control, owner }
  })

  server.registerTool(
    "automation_list",
    {
      description: "List the automations of this thread's owner: id, name, enabled state, trigger, repo, next run and prompt.",
      inputSchema: {},
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { control, owner } = yield* scope
            const automations = yield* control.list(owner)
            if (automations.length === 0) return text("no automations")
            return text(truncate(automations.map(formatAutomation).join("\n\n")))
          }),
        ),
      ),
  )

  server.registerTool(
    "automation_create",
    {
      description:
        "Create an automation for this thread's owner. Each run starts a new thread with the prompt, checking out `repo` " +
        "when one is given. A schedule trigger fires on a five-field cron in an IANA time zone. A github trigger fires on " +
        "pull request events in `repo` and needs the owner's GitHub connection, so it cannot be enabled without one. " +
        "Pass enabled: false to create it paused.",
      inputSchema: {
        name: z.string().min(1).describe("Short name shown in the app"),
        prompt: z.string().min(1).describe("Prompt the run's agent receives"),
        repo: z.string().optional().describe("GitHub repository (owner/name) that runs check out; required for github triggers"),
        trigger: triggerSchema,
        enabled: z.boolean().optional().describe("Whether it fires (default true)"),
      },
    },
    ({ name, repo, prompt, trigger, enabled }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { control, owner } = yield* scope
            const created = yield* control.create(owner, {
              name,
              repo,
              prompt,
              trigger,
              enabled,
            })
            return text(`created automation ${created.id}\n${formatAutomation(created)}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "automation_update",
    {
      description:
        "Change an automation of this thread's owner. Only the fields given change: name, prompt, trigger (the whole " +
        "trigger is replaced) or enabled. The repo cannot change.",
      inputSchema: {
        id: z.string().describe("Automation id from automation_list"),
        name: z.string().min(1).optional().describe("New name"),
        prompt: z.string().min(1).optional().describe("New prompt"),
        trigger: triggerSchema.optional().describe("New trigger, replacing the old one"),
        enabled: z.boolean().optional().describe("Turn it on or off"),
      },
    },
    ({ id, name, prompt, trigger, enabled }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { control, owner } = yield* scope
            const updated = yield* control.update(owner, id, { name, prompt, trigger, enabled })
            return text(`updated automation ${updated.id}\n${formatAutomation(updated)}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "automation_delete",
    {
      description: "Delete an automation of this thread's owner.",
      inputSchema: {
        id: z.string().describe("Automation id from automation_list"),
      },
    },
    ({ id }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { control, owner } = yield* scope
            yield* control.remove(owner, id)
            return text(`deleted automation ${id}`)
          }),
        ),
      ),
  )
}

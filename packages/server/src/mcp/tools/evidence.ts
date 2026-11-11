import { Paths, type RunClip } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text } from "./common"

export interface EvidenceToolDeps {
  readonly evidence: {
    /** Starts recording the task's desktop for the run; its desktop must be running. */
    readonly start: (taskId: string, runId: string, caption?: string) => Effect.Effect<void, unknown>
    /** Stops the run's recording and returns the saved clip. */
    readonly stop: (taskId: string, runId: string) => Effect.Effect<RunClip, unknown>
    /**
     * Uploads one of the run's clips, or its poster, to GitHub and comments it on the thread's linked pull request.
     * Creates no branch and no commit in the repository.
     */
    readonly attach: (
      taskId: string,
      input: {
        readonly caption: string
        readonly checkoutId?: string
        readonly runId?: string
        readonly clipId?: string
        readonly poster?: boolean
      },
    ) => Effect.Effect<{ readonly commentUrl: string; readonly evidenceUrl: string }, unknown>
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`

/** Tells the agent where the clip lives; the app renders it in the run summary from the same path. */
const clipReport = (taskId: string, runId: string, clip: RunClip): string =>
  [
    `Saved clip ${clip.id} for run ${runId}: ${Paths.taskRunClip(taskId, runId, clip.id)}`,
    clip.poster === null
      ? `Caption: ${clip.caption}; duration ${seconds(clip.durationMs)}; no poster was captured`
      : `Caption: ${clip.caption}; duration ${seconds(clip.durationMs)}; poster ${Paths.taskRunClip(taskId, runId, clip.poster)}`,
  ].join("\n")

/** Explicit desktop recordings: the run's own evidence, kept beside its other artifacts. */
export const registerEvidenceTools = (server: McpServer, ctx: RunContext, deps: EvidenceToolDeps): void => {
  server.registerTool(
    "evidence_attach_to_pr",
    {
      description:
        "Attach the run's saved desktop clip to the thread's linked open pull request. GitHub holds the file as a user " +
        "attachment, so this creates no branch and no commit in the repository and never changes the pull request's " +
        "branches. A video gets an inline player in a new comment; use poster to attach the poster image instead. " +
        "Record a clip first with evidence_record_start and evidence_record_stop. Attaching only works on github.com; " +
        "GitHub Enterprise Server has no user-attachments endpoint, and an upload cannot be deleted afterwards.",
      inputSchema: {
        caption: z
          .string()
          .min(1)
          .max(500)
          .describe("What the clip shows; the comment's text (or the image's alt text)"),
        checkout: z
          .string()
          .optional()
          .describe("Checkout id from repo_checkout; needed when the thread has several checkouts"),
        runId: z.string().optional().describe("Run whose saved clip to attach; default: this run"),
        clipId: z.string().optional().describe("Clip id from evidence_record_stop; default: the run's newest clip"),
        poster: z.boolean().optional().describe("Attach the clip's poster PNG instead of the MP4 (default false)"),
      },
    },
    ({ caption, checkout, runId, clipId, poster }: { readonly caption: string; readonly checkout?: string; readonly runId?: string; readonly clipId?: string; readonly poster?: boolean }) =>
      guard(() =>
        runTool(
          Effect.map(
            deps.evidence.attach(ctx.taskId, { caption, checkoutId: checkout, runId: runId ?? ctx.runId, clipId, poster }),
            (attached): CallToolResult =>
              text(
                `Attached ${poster === true ? "the poster image" : "the clip"} (${attached.evidenceUrl}) to the thread's pull request: ${attached.commentUrl}`,
              ),
          ),
        ),
      ),
  )

  server.registerTool(
    "evidence_record_start",
    {
      description:
        "Start recording the task's desktop to a video clip saved with this run. The desktop must be running; call " +
        "desktop_open first. One recording per run, and it stops with evidence_record_stop, which saves the MP4 and " +
        "returns its id and URL. The app shows the clip in the run summary. Use it for anything the user should be able " +
        "to check afterwards: an animation, a physics result or a UI flow.",
      inputSchema: {
        caption: z
          .string()
          .max(500)
          .optional()
          .describe("What the recording shows; the app shows it under the clip. Default: Desktop recording"),
      },
    },
    ({ caption }: { readonly caption?: string }) =>
      guard(() =>
        runTool(
          Effect.map(deps.evidence.start(ctx.taskId, ctx.runId, caption), () =>
            text(`Recording the desktop for run ${ctx.runId}. Stop it with evidence_record_stop to save the clip.`),
          ),
        ),
      ),
  )

  server.registerTool(
    "evidence_record_stop",
    {
      description:
        "Stop the run's recording and save it as an MP4 clip beside the run's artifacts. Returns the clip's id, URL and " +
        "caption; the app shows the poster and plays the clip in the run summary. A run with no recording in progress " +
        "is an error.",
    },
    () =>
      guard(() =>
        runTool(
          Effect.map(deps.evidence.stop(ctx.taskId, ctx.runId), (clip): CallToolResult =>
            text(clipReport(ctx.taskId, ctx.runId, clip)),
          ),
        ),
      ),
  )
}

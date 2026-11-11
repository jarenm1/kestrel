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

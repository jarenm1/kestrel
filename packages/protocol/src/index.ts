/**
 * @cloudagents/protocol — the single source of truth for wire types.
 *
 * Used by the server (Effect) and every client (web, later Electron).
 * Pure Effect Schema: no Node/DOM-specific imports here.
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export const Repo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Clone URL as given by the user. */
  url: Schema.String,
  /** Absolute path of the bare-ish clone on the server host. */
  localPath: Schema.String,
  defaultBranch: Schema.String,
  createdAt: Schema.String, // ISO-8601
  /**
   * GitHub login of the user who added the project. Only the owner can see or change it and its
   * tasks; access to the upstream repository is GitHub's (the clone uses the owner's token).
   */
  owner: Schema.String,
})
export type Repo = typeof Repo.Type

/**
 * idle          no run in flight
 * running       an agent run is executing in the worktree
 * needs_input   agent asked the user something (via MCP `task_report`)
 * done          agent reported completion
 * failed        last run exited non-zero
 */
export const TaskStatus = Schema.Literal("idle", "running", "needs_input", "done", "failed")
export type TaskStatus = typeof TaskStatus.Type

/** A task = one git worktree + one branch + one chat thread + (optional) one desktop. */
export const Task = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  title: Schema.String,
  /** Branch created for this task, e.g. `cloudagents/fix-login-a1b2`. */
  branch: Schema.String,
  baseBranch: Schema.String,
  /** Absolute path of the git worktree on the server host. */
  worktreePath: Schema.String,
  status: TaskStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Task = typeof Task.Type

export const Message = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  role: Schema.Literal("user", "agent", "system"),
  text: Schema.String,
  runId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})
export type Message = typeof Message.Type

export const RunStatus = Schema.Literal("running", "succeeded", "failed", "cancelled")
export type RunStatus = typeof RunStatus.Type

/** One agent-harness invocation against a task's worktree. */
export const Run = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  prompt: Schema.String,
  status: RunStatus,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
})
export type Run = typeof Run.Type

/**
 * stopped   no X display / capture running
 * starting  Xvfb + openbox + ffmpeg being spawned
 * running   stream is live; `mime` is set and binary frames are flowing
 * failed    see `error`
 */
export const DesktopState = Schema.Literal("stopped", "starting", "running", "failed")
export type DesktopState = typeof DesktopState.Type

export const DesktopStatus = Schema.Struct({
  taskId: Schema.String,
  state: DesktopState,
  /** X display string, e.g. ":101". Null when stopped. Injected as DISPLAY into agent runs. */
  display: Schema.NullOr(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  fps: Schema.Number,
  /**
   * MIME + codec string for MediaSource, e.g. `video/mp4; codecs="avc1.42E01F"`.
   * Null until the stream is running. Clients MUST use this verbatim.
   */
  mime: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type DesktopStatus = typeof DesktopStatus.Type

/**
 * Client -> server input over the desktop WebSocket (JSON text frames).
 * Coordinates are normalized to [0, 1] relative to the stream frame so the
 * client never needs to know the X resolution.
 */
export const DesktopInput = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("mouse.move"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("mouse.button"),
    x: Schema.Number,
    y: Schema.Number,
    /** 1 = left, 2 = middle, 3 = right */
    button: Schema.Literal(1, 2, 3),
    down: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("mouse.wheel"), dx: Schema.Number, dy: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("key"),
    /** X keysym name as understood by xdotool, e.g. "Return", "a", "ctrl+c" */
    key: Schema.String,
    down: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("text"), text: Schema.String }),
)
export type DesktopInput = typeof DesktopInput.Type

/** Server -> client events over the task event WebSocket (JSON text frames). */
export const ServerEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("task.updated"), task: Task }),
  Schema.Struct({ _tag: Schema.Literal("message.created"), message: Message }),
  Schema.Struct({ _tag: Schema.Literal("run.updated"), run: Run }),
  Schema.Struct({
    _tag: Schema.Literal("agent.output"),
    taskId: Schema.String,
    runId: Schema.String,
    /** "event" = harness-structured line (e.g. stream-json); "stdout"/"stderr" = raw. */
    stream: Schema.Literal("stdout", "stderr", "event"),
    text: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("desktop.updated"), desktop: DesktopStatus }),
)
export type ServerEvent = typeof ServerEvent.Type

// ---------------------------------------------------------------------------
// REST request / response bodies
// ---------------------------------------------------------------------------

export const CreateRepoBody = Schema.Struct({
  url: Schema.String,
  name: Schema.optional(Schema.String),
})
export type CreateRepoBody = typeof CreateRepoBody.Type

export const CreateTaskBody = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Base branch to fork the worktree from. Defaults to repo.defaultBranch. */
  baseBranch: Schema.optional(Schema.String),
})
export type CreateTaskBody = typeof CreateTaskBody.Type

export const SendMessageBody = Schema.Struct({ text: Schema.String })
export type SendMessageBody = typeof SendMessageBody.Type

export const SendMessageResponse = Schema.Struct({ message: Message, run: Run })
export type SendMessageResponse = typeof SendMessageResponse.Type

export const DiffResponse = Schema.Struct({ baseBranch: Schema.String, diff: Schema.String })
export type DiffResponse = typeof DiffResponse.Type

export const Health = Schema.Struct({ ok: Schema.Literal(true), version: Schema.String })
export type Health = typeof Health.Type

// ---------------------------------------------------------------------------
// Errors (serialized as JSON bodies with the matching HTTP status)
// ---------------------------------------------------------------------------

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// HTTP / WS paths (single place to change them)
// ---------------------------------------------------------------------------

export const Paths = {
  health: "/api/health",
  repos: "/api/repos",
  repo: (id: string) => `/api/repos/${id}`,
  repoTasks: (repoId: string) => `/api/repos/${repoId}/tasks`,
  task: (id: string) => `/api/tasks/${id}`,
  taskMessages: (id: string) => `/api/tasks/${id}/messages`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  taskDiff: (id: string) => `/api/tasks/${id}/diff`,
  taskDesktop: (id: string) => `/api/tasks/${id}/desktop`,
  runCancel: (id: string) => `/api/runs/${id}/cancel`,
  /** WebSocket: JSON `ServerEvent` text frames. */
  taskEventsWs: (id: string) => `/api/tasks/${id}/events`,
  /** WebSocket: server sends `DesktopStatus` JSON text frames + fMP4 binary frames; client sends `DesktopInput` JSON. */
  taskDesktopWs: (id: string) => `/api/tasks/${id}/desktop/stream`,
  /** MCP (streamable HTTP) endpoint for the agent harness. */
  mcp: (taskId: string) => `/mcp/${taskId}`,
} as const

export * from "./relay"
export * from "./control"

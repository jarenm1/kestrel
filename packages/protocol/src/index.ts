/**
 * @cloudagents/protocol — the single source of truth for wire types.
 *
 * Used by the server (Effect) and every client (web, later Electron).
 * Pure Effect Schema: no Node/DOM-specific imports here.
 */
import { Schema } from "effect"
import { AgentEffort, AgentModel, ModelProvider, modelInfo } from "./models"
import { BranchName, RepoRef } from "./refs"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * idle          no run in flight
 * running       an agent run is executing in the worktree
 * needs_input   agent asked the user something (via MCP `task_report`)
 * done          agent reported completion
 * failed        last run exited non-zero
 */
export const TaskStatus = Schema.Literal("idle", "running", "needs_input", "done", "failed")
export type TaskStatus = typeof TaskStatus.Type

/** The GitHub pull request opened for a checkout's branch (see the `github_pr_create` MCP tool). */
export const PullRequestLink = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
})
export type PullRequestLink = typeof PullRequestLink.Type

/**
 * A repository the agent checked out into its thread's workspace (MCP `repo_checkout`, or `CreateTaskBody.checkout`).
 * Each checkout is a clone of its own, on a branch created for the thread; a thread has at most one checkout per repo.
 */
export const Checkout = Schema.Struct({
  /** Stable within the thread; names the checkout in `DiffResponse` and the GitHub MCP tools. */
  id: Schema.String,
  /** GitHub "owner/name" for github.com repositories, otherwise the https clone URL. */
  repo: Schema.String,
  /** Directory of the checkout, relative to the thread workspace (the agent's working directory), e.g. `kestrel`. */
  dir: Schema.String,
  /** Branch created for this thread, e.g. `cloudagents/fix-login-a1b2`. */
  branch: Schema.String,
  /** Branch the checkout forked from and pull requests target. */
  baseBranch: Schema.String,
  createdAt: Schema.String,
  /** Set once a pull request has been opened for `branch`; absent before that. */
  pullRequest: Schema.optional(PullRequestLink),
})
export type Checkout = typeof Checkout.Type

/**
 * How full a thread's agent session is: the prompt and reply of the main agent's latest model call, against the
 * context window the harness reports for its model (Claude Code's `modelUsage.contextWindow`, codex's
 * `model_context_window`). A compaction shrinks it at the session's next model call.
 */
export const ContextUsage = Schema.Struct({
  /** Model id the harness reported for the session; null when it named none. */
  model: Schema.NullOr(Schema.String),
  usedTokens: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  windowTokens: Schema.Number.pipe(Schema.int(), Schema.positive()),
})
export type ContextUsage = typeof ContextUsage.Type

/**
 * A thread = one chat + one workspace directory + (optional) one desktop. It starts with no repository;
 * the agent checks repositories out into the workspace as the work needs them.
 */
export const Task = Schema.Struct({
  id: Schema.String,
  /** GitHub login of the user who started the thread. Only they can see or change it. */
  owner: Schema.String,
  title: Schema.String,
  status: TaskStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Oldest first. Empty until the agent checks a repository out. */
  checkouts: Schema.Array(Checkout),
  /** Port of the task's dev server, registered by its agent for the browser preview. */
  previewPort: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 65535))),
  /** Set while the thread is archived: its runtime is torn down and it accepts no new messages; absent otherwise. */
  archivedAt: Schema.optional(Schema.String),
  /** Context use of the thread's agent session as last reported; absent before a harness reports one and when a run starts a fresh session. */
  context: Schema.optional(ContextUsage),
})

/** Short-lived bearer used by a sandboxed preview frame; grants access only to its own task preview. */
export const PreviewSession = Schema.Struct({ token: Schema.String })
export type PreviewSession = typeof PreviewSession.Type
export type Task = typeof Task.Type

/**
 * A file on a message: one the agent attached (e.g. a desktop screenshot) or one the user uploaded with
 * `Paths.taskUploads` and sent with `SendMessageBody.attachments`. Bytes are served by `Paths.taskAttachment`.
 */
export const Attachment = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  /** File name the user uploaded it under; absent for agent attachments. */
  name: Schema.optional(Schema.String),
})
export type Attachment = typeof Attachment.Type

/** Largest attachment the box stores, agent or user; a larger upload is refused with 400. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export const Message = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  role: Schema.Literal("user", "agent", "system"),
  text: Schema.String,
  runId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** Choices offered with a question (`task_ask`); the user answers by sending one of them. */
  options: Schema.optional(Schema.Array(Schema.String)),
  /** Files attached by the agent (e.g. a desktop screenshot). Optional so messages persisted before attachments decode. */
  attachments: Schema.optional(Schema.Array(Attachment)),
  /**
   * Set when another agent of the thread's owner sent this message with the `thread_send` MCP tool: the thread it
   * came from, with that thread's title when it was sent. Absent on messages the user typed.
   */
  fromThread: Schema.optional(Schema.Struct({ id: Schema.String, title: Schema.String })),
})
export type Message = typeof Message.Type

export const RunStatus = Schema.Literal("running", "succeeded", "failed", "cancelled")
export type RunStatus = typeof RunStatus.Type

/** One agent-harness invocation in a thread's workspace. */
export const Run = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  prompt: Schema.String,
  status: RunStatus,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  /** The provider's CLI that ran it; absent on runs recorded before model switching stored it. */
  provider: Schema.optional(ModelProvider),
})
export type Run = typeof Run.Type

/**
 * One display item of an agent run, normalized from the harness's own stream (Claude
 * `stream-json`, Codex `exec --json`) so the app renders every harness the same way.
 * Ids are unique within a run; a later item with the same id replaces the earlier one
 * (a tool goes `running` -> `ok`/`error`).
 */
export const AgentItem = Schema.Union(
  /** Assistant prose; markdown, may contain inline HTML/SVG. */
  Schema.Struct({ _tag: Schema.Literal("text"), id: Schema.String, parentToolId: Schema.NullOr(Schema.String), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("thinking"), id: Schema.String, parentToolId: Schema.NullOr(Schema.String), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("tool"),
    id: Schema.String,
    /** Set when a subagent (e.g. Claude's Task tool) made this call; the id of that Task call. */
    parentToolId: Schema.NullOr(Schema.String),
    /** Harness tool name, e.g. "Bash", "mcp__cloudagents__desktop_screenshot", "command_execution". */
    name: Schema.String,
    input: Schema.Unknown,
    status: Schema.Literal("running", "ok", "error"),
    output: Schema.NullOr(Schema.String),
  }),
  /** End of one agent turn. Fields the harness does not report are null. */
  Schema.Struct({
    _tag: Schema.Literal("turn"),
    id: Schema.String,
    durationMs: Schema.NullOr(Schema.Number),
    inputTokens: Schema.NullOr(Schema.Number),
    outputTokens: Schema.NullOr(Schema.Number),
    costUsd: Schema.NullOr(Schema.Number),
    isError: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("error"), id: Schema.String, text: Schema.String }),
)
export type AgentItem = typeof AgentItem.Type

export const RunItems = Schema.Array(AgentItem)
export type RunItems = typeof RunItems.Type

/**
 * stopped   no X display / capture running
 * starting  X server (weston + Xwayland) + openbox + ffmpeg being spawned
 * running   stream is live; `mime` is set and binary frames are flowing
 * failed    see `error`
 */
export const DesktopState = Schema.Literal("stopped", "starting", "running", "failed")
export type DesktopState = typeof DesktopState.Type

/**
 * How the desktop is streamed: the encoder scales the display down to this size and caps its frame rate. The desktop
 * itself (`DesktopStatus.width`/`height`, screenshots, input) keeps its own resolution. One per desktop, shared by
 * every viewer; a new desktop starts at `DEFAULT_DESKTOP_QUALITY`.
 */
export const DesktopQuality = Schema.Literal("1080p30", "720p60")
export type DesktopQuality = typeof DesktopQuality.Type

export const DESKTOP_QUALITIES: Readonly<Record<DesktopQuality, { label: string; width: number; height: number; fps: number }>> = {
  "1080p30": { label: "1080p · 30 fps", width: 1920, height: 1080, fps: 30 },
  "720p60": { label: "720p · 60 fps", width: 1280, height: 720, fps: 60 },
}

export const DEFAULT_DESKTOP_QUALITY: DesktopQuality = "1080p30"

export const DesktopStatus = Schema.Struct({
  taskId: Schema.String,
  state: DesktopState,
  /** X display string, e.g. ":101". Null when stopped. Injected as DISPLAY into agent runs. */
  display: Schema.NullOr(Schema.String),
  /** The desktop's own resolution; its aspect ratio is the stream's. */
  width: Schema.Number,
  height: Schema.Number,
  /** The stream's frame rate cap, from `quality`. */
  fps: Schema.Number,
  quality: DesktopQuality,
  /**
   * MIME + codec string for MediaSource, e.g. `video/mp4; codecs="avc1.42E01F"`.
   * Null until the stream is running. Clients MUST use this verbatim.
   */
  mime: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type DesktopStatus = typeof DesktopStatus.Type

/** PUT `Paths.taskDesktopQuality` -> DesktopStatus. The encoder restarts at the new quality; viewers get a new init segment. */
export const SetDesktopQualityBody = Schema.Struct({ quality: DesktopQuality })
export type SetDesktopQualityBody = typeof SetDesktopQualityBody.Type

/**
 * One reading of a thread's resources against its own limits, in bytes. RAM and CPU come from the thread's systemd
 * slice and are null on a box without one (`CLOUDAGENTS_SYSTEMD=0`). VRAM is the whole GPU, shared by every thread
 * (there is no per-thread VRAM limit), and null without an NVIDIA GPU. Storage is the thread's files against its
 * storage limit; null until the box has measured them.
 */
export const TaskStatsSample = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** Share of the thread's CPU quota used since the previous sample, 0 to 1. */
  cpu: Schema.NullOr(Schema.Number),
  ramUsed: Schema.NullOr(Schema.Number),
  /** The thread's memory limit. */
  ramMax: Schema.NullOr(Schema.Number),
  vramUsed: Schema.NullOr(Schema.Number),
  vramTotal: Schema.NullOr(Schema.Number),
  /** The thread's workspace, home and git data. It can pass `diskMax` briefly; the box then stops what keeps it growing. */
  diskUsed: Schema.NullOr(Schema.Number),
  diskMax: Schema.Number,
})
export type TaskStatsSample = typeof TaskStatsSample.Type

/**
 * Over `Paths.taskStatsWs`: the first frame carries the last `TASK_STATS_WINDOW_MS` of samples, oldest first; every
 * later frame carries the samples taken since (normally one per `intervalMs`), to append.
 */
export const TaskStats = Schema.Struct({
  intervalMs: Schema.Number,
  samples: Schema.Array(TaskStatsSample),
})
export type TaskStats = typeof TaskStats.Type

export const TASK_STATS_WINDOW_MS = 60_000

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

/**
 * Client -> server flow-control ack over the desktop WebSocket (JSON text frames, sent alongside `DesktopInput`).
 * `frames` is the cumulative count of binary frames (init segment and fragments) the client has received on this
 * connection. The client sends one every ~100 ms or every 6 frames, whichever comes first. The server throttles a
 * connection only after its first ack, so clients that never ack keep the unthrottled stream.
 */
export const DesktopAck = Schema.Struct({ _tag: Schema.Literal("stream.ack"), frames: Schema.Number })
export type DesktopAck = typeof DesktopAck.Type

/** Server -> client events over the task event WebSocket (JSON text frames). */
export const ServerEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("task.updated"), task: Task }),
  /** The thread is gone (deleted, not archived). `owner` routes it to that user's `Paths.eventsWs` stream. */
  Schema.Struct({ _tag: Schema.Literal("task.deleted"), taskId: Schema.String, owner: Schema.String }),
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
  /** A run's display item was added or replaced (same `item.id`). */
  Schema.Struct({ _tag: Schema.Literal("agent.item"), taskId: Schema.String, runId: Schema.String, item: AgentItem }),
  Schema.Struct({ _tag: Schema.Literal("desktop.updated"), desktop: DesktopStatus }),
)
export type ServerEvent = typeof ServerEvent.Type

// ---------------------------------------------------------------------------
// REST request / response bodies
// ---------------------------------------------------------------------------

/**
 * A repository to check out. `repo` is a GitHub "owner/name" (cloned from github.com with the owner's token)
 * or an https clone URL. The box keeps one mirror per repository per user and always fetches it first,
 * so a checkout starts from the remote tip.
 */
export const CheckoutRequest = Schema.Struct({
  repo: RepoRef,
  /** Branch to fork from. Defaults to the repository's default branch; with `pullRequest`, the pull request's base. */
  baseBranch: Schema.optional(BranchName),
  /**
   * Start at the head of this GitHub pull request (`refs/pull/<n>/head`) instead of `baseBranch`. `baseBranch`
   * stays the pull request's base (for opening a pull request); the checkout's diff is against the head it started at.
   */
  pullRequest: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})
export type CheckoutRequest = typeof CheckoutRequest.Type

export const CreateTaskBody = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Check this repository out before the first message, e.g. for an automation on a pull request. */
  checkout: Schema.optional(CheckoutRequest),
})
export type CreateTaskBody = typeof CreateTaskBody.Type

export const SendMessageBody = Schema.Struct({
  /** May be empty when `attachments` is not. */
  text: Schema.String,
  /** Omitted = the box's default harness (Claude Code) with its default model. The model's provider picks the CLI. */
  model: Schema.optional(AgentModel),
  /** Omitted = the model's default level. Must be one of the model's `ModelInfo.efforts`. */
  effort: Schema.optional(AgentEffort),
  /**
   * Ids of attachments uploaded to this task with `Paths.taskUploads` and not yet sent. They move onto the new
   * message in this order; the agent gets each as a file in its sandbox, named in its prompt or `task_inbox`.
   */
  attachments: Schema.optional(Schema.Array(Schema.String)),
}).pipe(
  Schema.filter(
    (body) =>
      body.model === undefined ||
      body.effort === undefined ||
      modelInfo(body.model).efforts.includes(body.effort) ||
      `${modelInfo(body.model).name} does not support the "${body.effort}" thinking level`,
  ),
)
export type SendMessageBody = typeof SendMessageBody.Type

export const SendMessageResponse = Schema.Struct({ message: Message, run: Run })
export type SendMessageResponse = typeof SendMessageResponse.Type

/** Changes of one checkout: everything on its branch and in its working tree, against its fork point. */
export const CheckoutDiff = Schema.Struct({
  checkoutId: Schema.String,
  repo: Schema.String,
  dir: Schema.String,
  baseBranch: Schema.String,
  diff: Schema.String,
})
export type CheckoutDiff = typeof CheckoutDiff.Type

/** One entry per checkout, in `Task.checkouts` order; empty for a thread without checkouts. */
export const DiffResponse = Schema.Struct({ checkouts: Schema.Array(CheckoutDiff) })
export type DiffResponse = typeof DiffResponse.Type

/**
 * One command (Claude Code slash command, Codex skill) the authenticated harness offers in a thread's workspace.
 * `name` carries no leading `/` or `$`: the app shows the provider's native invocation prefix.
 */
export const HarnessCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** The CLI's own argument hint, when it publishes one (e.g. `[issue description]`). */
  argumentHint: Schema.optional(Schema.String),
})
export type HarnessCommand = typeof HarnessCommand.Type

/**
 * The commands of the harness the thread's next message will run on. `provider` is authoritative: while a run is
 * active the message joins that run, so the box answers for the run's provider even if the composer picked another.
 */
export const HarnessCommands = Schema.Struct({
  provider: ModelProvider,
  commands: Schema.Array(HarnessCommand),
})
export type HarnessCommands = typeof HarnessCommands.Type

export const Health = Schema.Struct({ ok: Schema.Literal(true), version: Schema.String })
export type Health = typeof Health.Type

/**
 * The signed-in user's agent usage in one billing period (a UTC calendar month). Agent time is the wall-clock time
 * their runs were active within the period; a run still going counts up to now.
 */
export const Usage = Schema.Struct({
  periodStart: Schema.String,
  periodEnd: Schema.String,
  agentSeconds: Schema.Number,
  runs: Schema.Number,
  threads: Schema.Number,
})
export type Usage = typeof Usage.Type

export type PlanId = "hobby" | "pro" | "team"

export interface Plan {
  readonly id: PlanId
  readonly name: string
  readonly price: string
  readonly period: string
  readonly desc: string
  /** Agent hours included per billing period; null is unlimited (fair use). */
  readonly agentHours: number | null
  readonly features: readonly string[]
}

/** Plans shown on the pricing page and in billing settings. */
export const PLANS: readonly Plan[] = [
  {
    id: "hobby",
    name: "Hobby",
    price: "$0",
    period: "forever",
    desc: "Try an agent box on a side project.",
    agentHours: 10,
    features: ["1 box, shared compute", "10 agent hours / month", "Live desktop at 1080p, 60 fps", "Bring your own model key"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$29",
    period: "per month",
    desc: "A dedicated box for daily agent work.",
    agentHours: 200,
    features: [
      "1 dedicated box",
      "200 agent hours / month",
      "Live desktop at 1080p, 60 fps",
      "Priority support",
    ],
  },
  {
    id: "team",
    name: "Team",
    price: "$99",
    period: "per seat / month",
    desc: "Boxes for the whole team, managed in one place.",
    agentHours: null,
    features: [
      "Dedicated box per seat",
      "Unlimited agent hours (fair use)",
      "GPU-accelerated desktops",
      "Shared repos and connections",
      "SSO and audit log",
    ],
  },
]

/** Billing is not live yet: every user is on this plan. */
export const CURRENT_PLAN: PlanId = "hobby"

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
  /** GET -> Usage of the signed-in user in the current billing period. */
  usage: "/api/usage",
  /** GET -> Task[]: every thread of the signed-in user, archived ones included. POST CreateTaskBody -> Task. */
  tasks: "/api/tasks",
  task: (id: string) => `/api/tasks/${id}`,
  /** POST archives the thread (tears down its desktop and sandbox, keeps history); DELETE unarchives it. Both return the Task. */
  taskArchive: (id: string) => `/api/tasks/${id}/archive`,
  taskMessages: (id: string) => `/api/tasks/${id}/messages`,
  /** GET `?model=<AgentModel>` -> HarnessCommands of the thread's next harness (active run wins). Names omit prefixes. */
  taskCommands: (id: string) => `/api/tasks/${id}/commands`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  taskDiff: (id: string) => `/api/tasks/${id}/diff`,
  taskDesktop: (id: string) => `/api/tasks/${id}/desktop`,
  taskDesktopQuality: (id: string) => `/api/tasks/${id}/desktop/quality`,
  /**
   * WebSocket: server sends `TaskStats` JSON text frames, the window so far and then new samples as they are taken.
   * The box samples the thread only while a stream is open (and briefly after), so the first frame may be short.
   */
  taskStatsWs: (id: string) => `/api/tasks/${id}/stats/stream`,
  /** Preview view path; the remaining path segments and query are proxied to the registered dev server. */
  taskPreview: (id: string) => `/api/tasks/${id}/preview`,
  /** POST -> PreviewSession: mints a short-lived token for the isolated/sandboxed browser preview. */
  taskPreviewSession: (id: string) => `/api/tasks/${id}/preview/session`,
  /** Sandboxed preview document path; `token` is scoped to `taskId` and cannot access the app session. */
  taskPreviewFrame: (token: string, taskId: string) => `/_preview/${token}/${taskId}/`,
  taskAttachment: (taskId: string, attachmentId: string) => `/api/tasks/${taskId}/attachments/${attachmentId}`,
  /**
   * POST the raw file bytes as the body (not multipart), its type as `Content-Type`, and its file name as the
   * optional `name` query parameter -> `Attachment`. The upload waits, unsent, until a `SendMessageBody.attachments`
   * names it; it is deleted with its task. At most `MAX_ATTACHMENT_BYTES`.
   */
  taskUploads: (id: string) => `/api/tasks/${id}/uploads`,
  runCancel: (id: string) => `/api/runs/${id}/cancel`,
  /** GET -> RunItems: the run's display items so far (live runs) or final (finished runs). */
  runItems: (id: string) => `/api/runs/${id}/items`,
  /** WebSocket: JSON `ServerEvent` text frames for one thread. */
  taskEventsWs: (id: string) => `/api/tasks/${id}/events`,
  /**
   * WebSocket: JSON `ServerEvent` text frames for the thread list of the signed-in user: `task.updated` for every one
   * of their threads (including new ones) and `task.deleted`. Replaces polling `Paths.tasks`.
   */
  eventsWs: "/api/events",
  /**
   * WebSocket: server sends `DesktopStatus` JSON text frames + fMP4 binary frames; client sends `DesktopInput` JSON
   * and `DesktopAck` JSON.
   */
  taskDesktopWs: (id: string) => `/api/tasks/${id}/desktop/stream`,
  /** MCP (streamable HTTP) endpoint for the agent harness. */
  mcp: (taskId: string) => `/mcp/${taskId}`,
} as const

export * from "./relay"
export * from "./control"
export * from "./refs"
export * from "./models"
export * from "./boxtoken"

/**
 * @cloudagents/protocol — the single source of truth for wire types.
 *
 * Used by the server (Effect) and every client (web, later Electron).
 * Pure Effect Schema: no Node/DOM-specific imports here.
 */
import { Schema } from "effect"
import { AgentEffort, AgentModel, ModelHarness, ModelProvider, modelInfo } from "./models"
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

/**
 * A GitHub pull request a thread owns or manages: one it opened or took over, or one it watches (see the
 * `github_pr_create` and `github_pr_watch` MCP tools). A thread has as many as it needs, in any repository.
 */
export const ThreadPullRequest = Schema.Struct({
  /** Stable within the thread: the repository and number, e.g. `owner/name#12`. */
  id: Schema.String,
  /** GitHub "owner/name". */
  repo: Schema.String,
  number: Schema.Number.pipe(Schema.int(), Schema.positive()),
  url: Schema.String,
  /**
   * The checkout the pull request is shown on. Its pushes update the pull request only once the entry is verified as
   * the checkout's own — a takeover, or a branch equal to the checkout's; an entry migrated from the old per-checkout
   * link carries this before that check. Absent for a pull request the thread only watches.
   */
  checkoutId: Schema.optional(Schema.String),
  /** The pull request's head branch, when it was known as the thread came to own it. */
  branch: Schema.optional(Schema.String),
  /** How the thread came to own it: opened from a checkout, taken over at checkout, or linked without a checkout. */
  source: Schema.Literal("opened", "takeover", "linked"),
  /** Activities (checks, reviews, comments) on it wake this thread, via the control plane's GitHub webhooks. */
  watching: Schema.optional(Schema.Boolean),
  addedAt: Schema.String,
})
export type ThreadPullRequest = typeof ThreadPullRequest.Type

/** The thread's pull requests, oldest first; empty for a thread that owns none. */
export const threadPullRequestsOf = (task: Pick<Task, "pullRequests">): ReadonlyArray<ThreadPullRequest> =>
  task.pullRequests ?? []

/** The registry id of a pull request, so the same repository and number never appear twice. */
export const threadPullRequestId = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`

/** The review verdict GitHub reports for a pull request, or `none` before anyone reviewed it. */
export const PullRequestReviewDecision = Schema.Literal("approved", "changes_requested", "commented", "none")

/** Counts of a pull request's check runs, as GitHub summarises them. */
export const PullRequestChecks = Schema.Struct({
  total: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  passed: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  failing: Schema.Array(Schema.String),
  pending: Schema.Array(Schema.String),
})

/** What GitHub says about one pull request right now. Absent when the last ask failed (see `ThreadPullRequestSummary.error`). */
export const ThreadPullRequestSnapshot = Schema.Struct({
  title: Schema.String,
  state: Schema.Literal("open", "closed", "merged"),
  draft: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  baseRef: Schema.String,
  headRef: Schema.String,
  /** owner/name the head branch lives in; a fork's for a pull request from one, null when that repository is gone. */
  headRepo: Schema.NullOr(Schema.String),
  /** null while GitHub is still computing mergeability. */
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeableState: Schema.String,
  reviewDecision: PullRequestReviewDecision,
  labels: Schema.Array(Schema.String),
  /** Logins of reviewers still requested, or of those whose review GitHub counts. */
  reviewers: Schema.Array(Schema.String),
  additions: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deletions: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  changedFiles: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  checks: PullRequestChecks,
})
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type

/** One pull request of a thread, with GitHub's live view of it when it could be read. */
export const ThreadPullRequestSummary = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  number: Schema.Number.pipe(Schema.int(), Schema.positive()),
  url: Schema.String,
  source: Schema.Literal("opened", "takeover", "linked"),
  checkoutId: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  watching: Schema.Boolean,
  addedAt: Schema.String,
  /** Absent while the box could not reach GitHub for it; `error` then says why. */
  snapshot: Schema.optional(ThreadPullRequestSnapshot),
  error: Schema.optional(Schema.String),
})
export type ThreadPullRequestSummary = typeof ThreadPullRequestSummary.Type

/** The pull requests of one thread, oldest first. */
export const ThreadPullRequests = Schema.Struct({ pullRequests: Schema.Array(ThreadPullRequestSummary) })
export type ThreadPullRequests = typeof ThreadPullRequests.Type

/** A review someone submitted on a pull request. */
export const PullRequestReview = Schema.Struct({
  author: Schema.String,
  state: Schema.String,
  body: Schema.String,
  url: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
})
export type PullRequestReview = typeof PullRequestReview.Type

/** A comment in a pull request's conversation, on its diff, or in a review's body. */
export const PullRequestComment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  kind: Schema.Literal("conversation", "review", "review_comment"),
  /** The diff file a review comment is on; null for conversation comments. */
  path: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Number),
})
export type PullRequestComment = typeof PullRequestComment.Type

/** One commit on a pull request's branch. */
export const PullRequestCommit = Schema.Struct({
  oid: Schema.String,
  headline: Schema.String,
  committedAt: Schema.String,
  author: Schema.NullOr(Schema.String),
})
export type PullRequestCommit = typeof PullRequestCommit.Type

/** A file a pull request changes; its patch text is in `ThreadPullRequestDiff`. */
export const PullRequestFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  additions: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deletions: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})
export type PullRequestFile = typeof PullRequestFile.Type

/** Everything the pull request view shows about one pull request. */
export const ThreadPullRequestDetail = Schema.Struct({
  summary: ThreadPullRequestSummary,
  body: Schema.String,
  reviews: Schema.Array(PullRequestReview),
  comments: Schema.Array(PullRequestComment),
  commits: Schema.Array(PullRequestCommit),
  files: Schema.Array(PullRequestFile),
})
export type ThreadPullRequestDetail = typeof ThreadPullRequestDetail.Type

/** A pull request's unified diff, as GitHub renders it; `truncated` when it was too large and was cut short. */
export const ThreadPullRequestDiff = Schema.Struct({ patch: Schema.String, truncated: Schema.Boolean })
export type ThreadPullRequestDiff = typeof ThreadPullRequestDiff.Type

/** A change the pull request view asks of one pull request of the thread. */
export const ThreadPullRequestAction = Schema.Union(
  Schema.Struct({ action: Schema.Literal("comment"), repo: Schema.String, number: Schema.Number.pipe(Schema.int(), Schema.positive()), body: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("review"),
    repo: Schema.String,
    number: Schema.Number.pipe(Schema.int(), Schema.positive()),
    body: Schema.String,
    verdict: Schema.Literal("comment", "approve", "request-changes"),
  }),
  Schema.Struct({
    action: Schema.Literal("merge"),
    repo: Schema.String,
    number: Schema.Number.pipe(Schema.int(), Schema.positive()),
    method: Schema.Literal("merge", "squash", "rebase"),
  }),
  Schema.Struct({ action: Schema.Literal("close"), repo: Schema.String, number: Schema.Number.pipe(Schema.int(), Schema.positive()) }),
  Schema.Struct({ action: Schema.Literal("reopen"), repo: Schema.String, number: Schema.Number.pipe(Schema.int(), Schema.positive()) }),
  Schema.Struct({
    action: Schema.Literal("watch"),
    repo: Schema.String,
    number: Schema.Number.pipe(Schema.int(), Schema.positive()),
    watching: Schema.Boolean,
  }),
)
export type ThreadPullRequestAction = typeof ThreadPullRequestAction.Type

/** The repository's own favicon/app icon, found in the checkout's starting commit. Bytes are served by `Paths.taskCheckoutIcon`. */
export const CheckoutIcon = Schema.Struct({
  /** Path of the icon in the repository, e.g. `public/favicon.svg`. */
  path: Schema.String,
  /** Git object id of the icon's bytes; it names the bytes, so URLs carrying it can be cached for good. */
  blob: Schema.String,
})
export type CheckoutIcon = typeof CheckoutIcon.Type

/**
 * A repository the agent checked out into its thread's workspace (MCP `repo_checkout`, or `CreateTaskBody.checkout`).
 * Each checkout is a clone of its own, on a branch created for the thread; a thread has at most one checkout per repo.
 */
export const Checkout = Schema.Struct({
  /** Stable within the thread; names the checkout in `DiffResponse` and the GitHub MCP tools. */
  id: Schema.String,
  /** GitHub "owner/name" for github.com repositories, otherwise the https clone URL. */
  repo: Schema.String,
  /** Directory of the checkout, relative to the thread workspace, e.g. `kestrel`. The agent starts in the first one. */
  dir: Schema.String,
  /** Branch created for this thread, e.g. `cloudagents/fix-login-a1b2`, or the branch of the pull request it took over. */
  branch: Schema.String,
  /** Branch the checkout forked from and pull requests target. */
  baseBranch: Schema.String,
  createdAt: Schema.String,
  /** The checkout uses a pull request's existing branch rather than a branch created for the thread. */
  pullRequestTakeover: Schema.optional(Schema.Boolean),
  /** Absent when the repository has no icon, or for checkouts made before icons were looked up. */
  icon: Schema.optional(CheckoutIcon),
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

/** The durable relationship between a delegated task and the run that requested it. */
export const Delegation = Schema.Struct({
  parentTaskId: Schema.String,
  parentRunId: Schema.String,
  requestId: Schema.String,
  fingerprint: Schema.String,
  runId: Schema.optional(Schema.String),
  cancelledAt: Schema.optional(Schema.String),
  resultAcknowledged: Schema.optional(Schema.Boolean),
  outputSchema: Schema.optional(Schema.Unknown),
})
export type Delegation = typeof Delegation.Type
export type ContextUsage = typeof ContextUsage.Type

/**
 * A failed run whose provider usage limit is armed to resume the thread when the window resets. The box sets it after
 * a usage-limit failure that names a provider-reported reset, whether or not auto-resume is on: `autoResume` is the
 * user's switch at arm time, and the thread's notice lets them change it for this one failure.
 */
export const UsageLimitResume = Schema.Struct({
  /** The failed run this arm belongs to: a newer run means the thread already continued. */
  runId: Schema.String,
  /** When the provider's exhausted window resets, as the provider reported it. */
  resetsAt: Schema.String,
  /** Whether this thread resumes by itself at the reset; off leaves it failed for the user. */
  autoResume: Schema.Boolean,
})
export type UsageLimitResume = typeof UsageLimitResume.Type

/**
 * A failed run whose automatic retry waits for its backoff. The box schedules it after any failure except a
 * provider usage limit (that one has `UsageLimitResume`), so a transient provider, network or startup failure does
 * not leave the thread failed. A user reply, a new run or the last retry cancels it.
 */
export const AutoRetry = Schema.Struct({
  /** The failed run this retry belongs to: a newer run means the thread already moved on. */
  runId: Schema.String,
  /** The retry number that will start, 1-based. */
  attempt: Schema.Number.pipe(Schema.int(), Schema.positive()),
  /** Epoch time the retry may start, after its backoff. */
  nextAt: Schema.String,
})
export type AutoRetry = typeof AutoRetry.Type

/**
 * A thread = one chat + one workspace directory + (optional) one desktop. It starts with no repository;
 * the agent checks repositories out into the workspace as the work needs them.
 */
export const Task = Schema.Struct({
  id: Schema.String,
  /** GitHub login of the user who started the thread. Only they can see or change it. */
  owner: Schema.String,
  title: Schema.String,
  /** Generate a title from the first accepted message; cleared when generation starts or the user renames it. */
  generateTitle: Schema.optional(Schema.Boolean),
  status: TaskStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Oldest first. Empty until the agent checks a repository out. */
  checkouts: Schema.Array(Checkout),
  /** Pull requests the thread owns or manages, oldest first; absent in threads that own none. */
  pullRequests: Schema.optional(Schema.Array(ThreadPullRequest)),
  /** Repository the user started the thread on without naming a branch; its agent picks what to check out. */
  pickedRepo: Schema.optional(RepoRef),
  /** Port of the task's dev server, registered by its agent for the browser preview. */
  previewPort: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 65535))),
  /** Set while the thread is archived: its runtime is torn down and it accepts no new messages; absent otherwise. */
  archivedAt: Schema.optional(Schema.String),
  /** Context use of the thread's agent session as last reported; absent before a harness reports one and when a run starts a fresh session. */
  context: Schema.optional(ContextUsage),
  /** Present for a thread created as delegated work. */
  delegation: Schema.optional(Delegation),
  /** Parent of a thread created with thread_spawn; peer messages do not set this. */
  spawnedByTaskId: Schema.optional(Schema.String),
  /** Present while a usage-limit failure is waiting for its provider window to reset. */
  usageLimitResume: Schema.optional(UsageLimitResume),
  /** Present while an automatic retry of the thread's failed run waits for its backoff. */
  autoRetry: Schema.optional(AutoRetry),
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
  /**
   * Set on a user message that reached a run already going (a steer, an answer, or mail for its inbox): how many of
   * the run's display items it had shown by then, so the message reads at that point of the transcript. Absent on a
   * run's prompt and on messages persisted before it was recorded.
   */
  afterItems: Schema.optional(Schema.Number),
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
  /** The harness that actually ran it (a route id may differ from the provider's current harness); absent on old runs. */
  harness: Schema.optional(ModelHarness),
  /** Explicit model selected for this run; absent for runs using the box default. */
  model: Schema.optional(AgentModel),
  /** Thinking level selected for this run; null is the model default, absent on older runs. */
  effort: Schema.optional(Schema.NullOr(AgentEffort)),
  /** This run was still active when the box restarted and was reconciled as failed. */
  interruptedByRestart: Schema.optional(Schema.Boolean),
  /** Set on a run started automatically after the thread's previous run failed: its retry number, 1-based. */
  autoRetryAttempt: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})
export type Run = typeof Run.Type

/**
 * One display item of an agent run, normalized from the harness's own stream (Claude
 * `stream-json`, Codex app-server notifications) so the app renders every harness the same way.
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
    /**
     * Images the result returned (a desktop screenshot), served by `Paths.taskRunImage`; their `[image]` placeholder
     * is not in `output`. Absent on items from before images were kept, and when the result had none.
     */
    images: Schema.optional(Schema.Array(Attachment)),
  }),
  /**
   * One finished assistant response: its token usage as the harness reported it, not the run's running totals.
   * `timestamp` is when it finished, `durationMs` how long the response itself took. `inputTokens` excludes cache
   * reads (cache writes count as input); `cachedTokens` is null when the harness did not report it, never an invented
   * zero. It ends the stream it followed.
   */
  Schema.Struct({
    _tag: Schema.Literal("usage"),
    id: Schema.String,
    /** Set when a subagent (e.g. Claude's Task tool) produced this response; the id of that Task call. */
    parentToolId: Schema.NullOr(Schema.String),
    timestamp: Schema.String,
    /**
     * The response's elapsed time, from its first token request to its completion. Tool execution between responses
     * is not part of it. Null when the harness reported no start (or no end) to measure, never an estimate; absent on
     * responses recorded before it was kept.
     */
    durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
    inputTokens: Schema.NullOr(Schema.Number),
    outputTokens: Schema.NullOr(Schema.Number),
    cachedTokens: Schema.NullOr(Schema.Number),
  }),
  /** End of one agent turn. Fields the harness does not report are null. */
  Schema.Struct({
    _tag: Schema.Literal("turn"),
    id: Schema.String,
    /**
     * When the turn ended: its event's time when the harness reports one, else when the box saw it. Absent on turns
     * recorded before it was kept.
     */
    timestamp: Schema.optional(Schema.String),
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
  error: Schema.NullOr(Schema.String),
})
export type DesktopStatus = typeof DesktopStatus.Type

/** PUT `Paths.taskDesktopQuality` -> DesktopStatus. The encoder restarts at the new quality; viewers renegotiate. */
export const SetDesktopQualityBody = Schema.Struct({ quality: DesktopQuality })
export type SetDesktopQualityBody = typeof SetDesktopQualityBody.Type

/**
 * One application's share of a thread's resources: its processes in the thread's systemd slice, grouped by program
 * (`node · vite` for a script run by node, bun, deno or python). `name` is null for the remainder past the largest
 * groups, summed.
 */
export const TaskAppUsage = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  processes: Schema.Number,
  /**
   * Proportional anonymous and shared memory in bytes (Pss_Anon + Pss_Shmem): a page several processes share, such as
   * a fork's copy-on-write pages, is divided between them, so the groups add up without counting a page twice.
   */
  ramUsed: Schema.Number,
  /** Share of the thread's CPU quota used since the previous sample, 0 to 1. */
  cpu: Schema.Number,
})
export type TaskAppUsage = typeof TaskAppUsage.Type

/**
 * What a thread's RAM holds besides its processes' own memory, in bytes, from its slice's `memory.stat`. With
 * `TaskAppUsage.ramUsed` over every group it adds up to `TaskStatsSample.ramUsed`, give or take what changed between
 * the reads.
 */
export const TaskRamOther = Schema.Struct({
  /** File contents cached in RAM: the kernel can reclaim it before the thread hits its limit. */
  pageCache: Schema.Number,
  /** Files in tmpfs (the sandbox's `/tmp`) and shared memory no process maps. */
  tmpfs: Schema.Number,
  /** The kernel's own memory for the thread: page tables, sockets, slab. */
  kernel: Schema.Number,
})
export type TaskRamOther = typeof TaskRamOther.Type

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
  /**
   * The slice's applications, most memory first; empty without systemd. Absent from boxes older than the field, so
   * clients treat a missing list as unknown rather than empty.
   */
  apps: Schema.optional(Schema.Array(TaskAppUsage)),
  /** The rest of `ramUsed` beside `apps`; null without systemd, absent from boxes older than the field. */
  ramOther: Schema.optional(Schema.NullOr(TaskRamOther)),
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
 * Client -> server input (JSON text) over the WebRTC data channels: `input` carries clicks, wheel, keys and text, and
 * `pointer` carries `mouse.move` only. Coordinates are normalized to [0, 1] relative to the stream frame so the client
 * never needs to know the X resolution.
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
  /** Notch counts (integers); the server clamps each event to ±10. Positive dy scrolls down, positive dx right. */
  Schema.Struct({ _tag: Schema.Literal("mouse.wheel"), dx: Schema.Number, dy: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("key"),
    /** X keysym name as understood by xdotool, e.g. "Return", "a", "ctrl+c" */
    key: Schema.String,
    down: Schema.Boolean,
  }),
  /** Typed with xdotool `type`; soft keyboards send their text this way. */
  Schema.Struct({ _tag: Schema.Literal("text"), text: Schema.String.pipe(Schema.maxLength(1000)) }),
)
export type DesktopInput = typeof DesktopInput.Type

/** A STUN or TURN server for one WebRTC session, as `RTCPeerConnection` takes it. */
export const DesktopRtcIceServer = Schema.Struct({
  urls: Schema.Array(Schema.String),
  username: Schema.optional(Schema.String),
  credential: Schema.optional(Schema.String),
})
export type DesktopRtcIceServer = typeof DesktopRtcIceServer.Type

/** Box-authenticated request for managed TURN credentials; never exposes the provider API token. */
export const BOX_TURN_PATH = "/box/turn"
export const BoxTurnCredentials = Schema.Struct({
  iceServers: Schema.Array(DesktopRtcIceServer),
  expiresAt: Schema.Number,
})
export type BoxTurnCredentials = typeof BoxTurnCredentials.Type

/** An ICE candidate in either direction; a null `candidate` ends the viewer's gathering. */
const DesktopRtcCandidate = Schema.Struct({
  _tag: Schema.Literal("rtc.candidate"),
  candidate: Schema.NullOr(Schema.String),
  sdpMid: Schema.NullOr(Schema.String),
  sdpMLineIndex: Schema.NullOr(Schema.Number),
})

/**
 * Client -> box WebRTC signaling over the desktop WebSocket, which already proved who the viewer is. `rtc.offer` carries
 * the viewer's SDP offer (recvonly video and audio, and the `input` and `pointer` data channels); `rtc.candidate`
 * trickles its ICE candidates; `rtc.close` ends the session; `rtc.config.request` asks for a new `rtc.config`, whose TURN
 * credentials are fresh, before a retry on an old one.
 */
export const DesktopRtcClientMessage = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("rtc.offer"), sdp: Schema.String }),
  DesktopRtcCandidate,
  Schema.Struct({ _tag: Schema.Literal("rtc.close") }),
  Schema.Struct({ _tag: Schema.Literal("rtc.config.request") }),
)
export type DesktopRtcClientMessage = typeof DesktopRtcClientMessage.Type

/** A safe, enumerated reason TURN credentials were unusable. Never provider text, a URL, or a credential. */
export const DesktopTurnIssue = Schema.Literal(
  "control-timeout",
  "control-unreachable",
  "control-rejected",
  "configuration-incomplete",
  "provider-unavailable",
  "provider-unusable",
  "invalid-answer",
  "expired",
  "no-usable-turn",
  "local-incomplete",
  "control-error",
)
export type DesktopTurnIssue = typeof DesktopTurnIssue.Type

/** The safe part of a failed box-authenticated TURN request; enough to identify the fix without box logs. */
export const BoxTurnError = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  issue: Schema.optional(DesktopTurnIssue),
})
export type BoxTurnError = typeof BoxTurnError.Type

/**
 * Redacted box-side desktop connection evidence. Never carries credentials, addresses, URLs, SDP or raw provider errors.
 * A missing relay is independent of direct ICE: a connection may still succeed without a relay candidate.
 */
export const DesktopRtcBoxDiagnostics = Schema.Struct({
  turnSource: Schema.Literal("managed", "local", "none"),
  turnStatus: Schema.Literal("configured", "unavailable", "not-configured"),
  /** Optional so a box deployed before this field keeps producing decodable diagnostics. */
  turnIssue: Schema.optional(Schema.NullOr(DesktopTurnIssue)),
  gathering: Schema.Literal("idle", "gathering", "complete", "failed"),
  relayCandidates: Schema.Number,
  connection: Schema.Literal("new", "connecting", "connected", "disconnected", "failed", "closed"),
  failure: Schema.NullOr(Schema.Literal("turn-credentials", "relay-allocation", "negotiation", "connection-timeout")),
})
export type DesktopRtcBoxDiagnostics = typeof DesktopRtcBoxDiagnostics.Type

/** Box -> client WebRTC signaling over the desktop WebSocket, next to `DesktopStatus`. */
export const DesktopRtcServerMessage = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal("rtc.config"),
    iceServers: Schema.Array(DesktopRtcIceServer),
    iceTransportPolicy: Schema.Literal("all", "relay"),
  }),
  /** `retryable`: the box is at its viewer limit or negotiation failed, so a later try may work; false: no usable H.264. */
  Schema.Struct({ _tag: Schema.Literal("rtc.unavailable"), reason: Schema.String, retryable: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("rtc.answer"), sdp: Schema.String }),
  DesktopRtcCandidate,
  Schema.Struct({ _tag: Schema.Literal("rtc.diagnostics"), diagnostics: DesktopRtcBoxDiagnostics }),
)
export type DesktopRtcServerMessage = typeof DesktopRtcServerMessage.Type

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
   * Take over this GitHub pull request: start at its head (`refs/pull/<n>/head`) on its own branch, linked to it, so
   * pushes update it. A pull request from a fork or not open starts on a new thread branch, still linked. `baseBranch`
   * stays the pull request's base; the checkout's diff is against the head it started at.
   */
  pullRequest: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** With `pullRequest`: start at its head on a new thread branch, unlinked, so nothing the run pushes can move it. */
  detached: Schema.optional(Schema.Boolean),
})
export type CheckoutRequest = typeof CheckoutRequest.Type

/** Per-user, per-box preferences for short generated text and assistant response presentation. */
export const TextGenerationSettings = Schema.Struct({
  /** Off preserves prompt-derived titles and unbuffered assistant streaming. */
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  /** Null uses the conversation's model. */
  model: Schema.NullOr(AgentModel),
  effort: Schema.NullOr(AgentEffort),
  threadTitleInstructions: Schema.String,
  responseStreamingMode: Schema.Literal("turn", "paragraph"),
}).pipe(
  Schema.filter((settings) =>
    settings.model === null ||
    settings.effort === null ||
    modelInfo(settings.model).efforts.includes(settings.effort) ||
    "The selected model does not support that thinking level",
  ),
)
export type TextGenerationSettings = typeof TextGenerationSettings.Type

export const DEFAULT_TEXT_GENERATION_SETTINGS: TextGenerationSettings = {
  enabled: true,
  model: null,
  effort: null,
  threadTitleInstructions: "",
  responseStreamingMode: "paragraph",
}

/** Per-user, per-box preferences for how threads run, apart from generated text. */
export const ThreadSettings = Schema.Struct({
  /**
   * After a run fails on its provider's usage limit, resume the thread with "Continue where you left off." when the
   * provider reports the exhausted window's reset. Off leaves the thread failed for the user to retry.
   */
  autoResumeAfterUsageLimits: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})
export type ThreadSettings = typeof ThreadSettings.Type

export const DEFAULT_THREAD_SETTINGS: ThreadSettings = { autoResumeAfterUsageLimits: false }

export const CreateTaskBody = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Opt into an agent-generated title; an explicit title remains the provisional label until it arrives. */
  generateTitle: Schema.optional(Schema.Boolean),
  /** Check this repository out before the first message, e.g. for an automation on a pull request. */
  checkout: Schema.optional(CheckoutRequest),
  /** Point the agent at this repository and let it pick the branch or pull request to check out (`Task.pickedRepo`). */
  pickedRepo: Schema.optional(RepoRef),
})
export type CreateTaskBody = typeof CreateTaskBody.Type

/** Whether the thread's armed usage-limit auto-resume should run at the provider's reset. */
export const SetUsageLimitAutoResumeBody = Schema.Struct({ autoResume: Schema.Boolean })
export type SetUsageLimitAutoResumeBody = typeof SetUsageLimitAutoResumeBody.Type

/**
 * The control plane's watch state for one pull request of a thread. The box uses `watching: false` when the control
 * plane dropped the watch (the pull request closed), to clear the registry's mark; the entry itself stays.
 */
export const SetPullRequestWatchingBody = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number.pipe(Schema.int(), Schema.positive()),
  watching: Schema.Boolean,
})
export type SetPullRequestWatchingBody = typeof SetPullRequestWatchingBody.Type

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

/** Most file paths a checkout lists in `FilesResponse`; a larger tree is cut off and marked `truncated`. */
export const MAX_CHECKOUT_FILES = 20_000

/** Files of one checkout's working tree: what its `.gitignore` files do not ignore, plus files committed at its HEAD. */
export const CheckoutFiles = Schema.Struct({
  checkoutId: Schema.String,
  repo: Schema.String,
  dir: Schema.String,
  /** Paths relative to the checkout, `/`-separated, sorted; directories are implied by their files. */
  files: Schema.Array(Schema.String),
  /** True when the tree has more than `MAX_CHECKOUT_FILES` files and `files` holds only the first ones. */
  truncated: Schema.Boolean,
})
export type CheckoutFiles = typeof CheckoutFiles.Type

/** A file outside the repositories, with what the Files tab shows about it. */
export const FolderFile = Schema.Struct({
  /** Relative to its folder, `/`-separated. */
  path: Schema.String,
  size: Schema.Number,
  /** ISO-8601. */
  modifiedAt: Schema.String,
})
export type FolderFile = typeof FolderFile.Type

/**
 * The regular files of a folder of the thread (symlinks left out), depth first with each directory's entries sorted by
 * name. Hidden ones (a dot name, or `node_modules`/`__pycache__` anywhere on the path) only when asked for.
 */
export const FolderFiles = Schema.Struct({
  files: Schema.Array(FolderFile),
  /** True when the folder has more than `MAX_CHECKOUT_FILES` files and `files` holds only the first ones. */
  truncated: Schema.Boolean,
})
export type FolderFiles = typeof FolderFiles.Type

/** Older boxes send no folders; they decode as empty. */
const noFolderFiles = (): FolderFiles => ({ files: [], truncated: false })

/**
 * `GET Paths.taskFiles(id)` (`?hidden=1` adds hidden files to the folders). `checkouts` has one entry per checkout, in
 * `Task.checkouts` order. `workspace` is the thread workspace without its checkouts; `home` is the agent's
 * home, where desktop apps save.
 */
export const FilesResponse = Schema.Struct({
  checkouts: Schema.Array(CheckoutFiles),
  workspace: Schema.optionalWith(FolderFiles, { default: noFolderFiles, exact: true }),
  home: Schema.optionalWith(FolderFiles, { default: noFolderFiles, exact: true }),
})
export type FilesResponse = typeof FilesResponse.Type

/** Which folder a download path is relative to: the thread's workspace, the agent's home, or a checkout (by id). */
export type FileRoot = "workspace" | "home" | { readonly checkoutId: string }

/**
 * Largest response the box sends through the legacy relay: a relay frame carries the body base64-encoded, and
 * Cloudflare refuses WebSocket messages over 32 MiB. A larger one is answered 413. Direct boxes have no such limit.
 */
export const MAX_RELAY_RESPONSE_BYTES = 20 * 1024 * 1024

/**
 * One command the authenticated harness offers in a thread's workspace: a Claude Code slash command, a Codex
 * command (`/compact`, `/review`, `/init`) or a Codex skill. `name` carries no leading `/` or `$`.
 */
export const HarnessCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** The CLI's own argument hint, when it publishes one (e.g. `[issue description]`). */
  argumentHint: Schema.optional(Schema.String),
  /** How the command is typed: `$` for a Codex skill. Absent from older boxes: `$` for Codex, `/` for Claude Code. */
  prefix: Schema.optional(Schema.Literal("/", "$")),
})
export type HarnessCommand = typeof HarnessCommand.Type

/**
 * The commands of the harness the thread's next message will run on. `provider` is authoritative: while a run is
 * active the message joins that run, so the box answers for the run's provider even if the composer picked another.
 */
export const HarnessCommands = Schema.Struct({
  provider: ModelProvider,
  /** The harness the commands come from; absent from older boxes (derive from provider or the model's route). */
  harness: Schema.optional(ModelHarness),
  commands: Schema.Array(HarnessCommand),
})
export type HarnessCommands = typeof HarnessCommands.Type

/**
 * Version 1 describes configuration and desktop prerequisites, not a guarantee of a successful start. The `platform`
 * and `sandbox` value sets are closed within version 1: a new value is a new contract version.
 */
export const BoxCapabilities = Schema.Struct({
  version: Schema.Literal(1),
  platform: Schema.Literal("linux", "wsl", "lima", "other"),
  sandbox: Schema.Literal("strict", "basic", "off"),
  desktop: Schema.Literal("prerequisites-present", "unavailable"),
  /**
   * Model providers whose harness CLI the box found at startup, new enough to run. Absent on boxes from before it was
   * reported. Clients offer a provider that needs no connection only when its harness is listed here.
   */
  harnesses: Schema.optional(Schema.Array(ModelProvider)),
  /**
   * Harness kinds the box can launch, including route-only harnesses such as a recent OpenCode CLI. Absent on boxes
   * from before model routing; clients should fall back to `harnesses` and the provider's current harness.
   */
  modelHarnesses: Schema.optional(Schema.Array(ModelHarness)),
  /**
   * The box's GPU: `none`, `static` (a GPU the machine always has), or `on-demand` (a Nest VM that borrows one from its
   * host while needed, see `guest.ts`). Absent on boxes from before it was reported; treat as unknown.
   */
  gpu: Schema.optional(Schema.Literal("none", "static", "on-demand")),
  /** True on a Nest VM: the box suspends when idle and resumes on the next request. Absent means false. */
  suspend: Schema.optional(Schema.Boolean),
})
export type BoxCapabilities = typeof BoxCapabilities.Type

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

/** One local calendar day with agent activity: the runs started that day, and those runs' active time. */
export const ActivityDay = Schema.Struct({
  /** `YYYY-MM-DD` in the requested time zone. */
  date: Schema.String,
  runs: Schema.Number,
  agentSeconds: Schema.Number,
})
export type ActivityDay = typeof ActivityDay.Type

/** The signed-in user's daily agent activity over the last year; days without a run are left out. */
export const UsageActivity = Schema.Struct({
  timeZone: Schema.String,
  days: Schema.Array(ActivityDay),
})
export type UsageActivity = typeof UsageActivity.Type

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
  capabilities: "/api/capabilities",
  /** GET -> ModelCatalog on the selected box; ?refresh=1 bypasses the owner's discovery cache. */
  models: "/api/models",
  /** GET / PUT TextGenerationSettings: the signed-in user's preferences on this box. */
  textGenerationSettings: "/api/settings/text-generation",
  /** GET / PUT ThreadSettings: the signed-in user's thread preferences on this box. */
  threadSettings: "/api/settings/threads",
  /** POST a browser's `WebRtcOffer` (box token) -> `WebRtcAnswer`: opens the direct data channel of a user box. */
  webrtcOffer: "/api/webrtc/offer",
  /** GET -> Usage of the signed-in user in the current billing period. */
  usage: "/api/usage",
  /** GET `?tz=<IANA zone>` -> UsageActivity of the signed-in user, days counted in that zone. */
  usageActivity: "/api/usage/activity",
  /** GET -> Task[]: every thread of the signed-in user, archived ones included. POST CreateTaskBody -> Task. */
  tasks: "/api/tasks",
  task: (id: string) => `/api/tasks/${id}`,
  /** POST archives the thread (tears down its desktop and sandbox, keeps history); DELETE unarchives it. Both return the Task. */
  taskArchive: (id: string) => `/api/tasks/${id}/archive`,
  taskMessages: (id: string) => `/api/tasks/${id}/messages`,
  /**
   * POST `SetPullRequestWatchingBody`: the control plane dropped this watch (the pull request closed). Clears the
   * thread's watch mark; a late or repeated call is a no-op, and the registry entry stays.
   */
  taskPullRequestWatching: (id: string) => `/api/tasks/${id}/pull-request/watching`,
  /** GET `?model=<AgentModel>` -> HarnessCommands of the thread's next harness (active run wins). Names omit prefixes. */
  taskCommands: (id: string) => `/api/tasks/${id}/commands`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  /** POST cancels a child delegation and its descendants, returning the child thread. */
  taskDelegationCancel: (id: string, childId: string) => `/api/tasks/${id}/delegations/${childId}/cancel`,
  /** PUT SetUsageLimitAutoResumeBody -> Task: turns the thread's armed auto-resume on or off. */
  taskUsageLimit: (id: string) => `/api/tasks/${id}/usage-limit`,
  taskDiff: (id: string) => `/api/tasks/${id}/diff`,
  /** GET -> ThreadPullRequests: every pull request the thread owns or manages, with GitHub's live view of each. */
  taskPullRequests: (id: string) => `/api/tasks/${id}/pull-requests`,
  /** GET -> ThreadPullRequestDetail for one of the thread's pull requests (name it by `repo` and `number`). */
  taskPullRequest: (id: string, repo: string, number: number) =>
    `/api/tasks/${id}/pull-request?${new URLSearchParams({ repo, number: String(number) }).toString()}`,
  /** GET -> ThreadPullRequestDiff: the pull request's unified diff. */
  taskPullRequestDiff: (id: string, repo: string, number: number) =>
    `/api/tasks/${id}/pull-request/diff?${new URLSearchParams({ repo, number: String(number) }).toString()}`,
  /** POST a ThreadPullRequestAction -> Task: comments, reviews, merging, closing, reopening, watching. */
  taskPullRequestAction: (id: string) => `/api/tasks/${id}/pull-request/action`,
  taskFiles: (id: string) => `/api/tasks/${id}/files`,
  /**
   * GET -> the bytes of one file of the thread as a download (`Content-Disposition: attachment`). `path` is relative to
   * `root`, `/`-separated; only regular files inside the root are served.
   */
  taskFileDownload: (id: string, root: FileRoot, path: string) =>
    `/api/tasks/${id}/files/download?${new URLSearchParams({
      root: typeof root === "string" ? root : "checkout",
      ...(typeof root === "string" ? {} : { checkout: root.checkoutId }),
      path,
    }).toString()}`,
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
  /** The bytes of `CheckoutIcon.blob`; the blob in the path makes the URL immutable. */
  taskCheckoutIcon: (taskId: string, checkoutId: string, blob: string) =>
    `/api/tasks/${taskId}/checkouts/${checkoutId}/icon/${blob}`,
  /** An image a tool call returned (`images` on a tool item); the id names the bytes, so the URL is immutable. */
  taskRunImage: (taskId: string, runId: string, imageId: string) => `/api/tasks/${taskId}/runs/${runId}/images/${imageId}`,
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
   * WebSocket: server sends `DesktopStatus` JSON text frames and WebRTC signaling (`DesktopRtcServerMessage`); the client
   * sends WebRTC signaling (`DesktopRtcClientMessage`). Video and audio travel over WebRTC; input over its data channels.
   */
  taskDesktopWs: (id: string) => `/api/tasks/${id}/desktop/stream`,
  /** MCP (streamable HTTP) endpoint for the agent harness. */
  mcp: (taskId: string) => `/mcp/${taskId}`,
} as const

export * from "./relay"
export * from "./rtc"
export * from "./control"
export * from "./meter"
export * from "./nest"
export * from "./guest"
export * from "./refs"
export * from "./models"
export * from "./boxtoken"
export * from "./tool-names"
export * from "./tool-display"
export * from "./live-items"
export * from "./transcript-segments"
export * from "./thread-identity"
export * from "./task-state"
export * from "./snapshot"

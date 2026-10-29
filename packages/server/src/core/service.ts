import { Cause, Context, Data, Deferred, Effect, Either, Layer, Schedule } from "effect"
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  BadRequest,
  Conflict,
  DEFAULT_MODEL_PROVIDER,
  DesktopStatus,
  type DesktopQuality,
  DiffResponse,
  InternalError,
  MAX_ATTACHMENT_BYTES,
  Message,
  type AgentItem,
  type AgentModel,
  type Attachment,
  NotFound,
  Paths,
  type PullRequestLink,
  Run,
  type Usage,
  SendMessageResponse,
  Task,
  type TaskStatus,
  type Checkout,
  type CheckoutRequest,
  type CliProvider,
  type CreateTaskBody,
  type HarnessCommands,
  modelInfo,
  providerModels,
} from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { Config } from "../config"
import { DesktopError, DesktopManager } from "../desktop"
import { CredentialStore } from "../credentials"
import { GitHub, GitHubError, type NewReview, type PostedReview, type PullRequest, type PullRequestStatus, type RepoSlug } from "../github/api"
import { agentHome, desktopNamespace, openTaskPreviewSocket, prepareLaunch, removeTask, runProcess, sandboxSettingsOf, stopAllTaskNets, stopTaskNet, taskPreviewFetch, type LaunchKind, type ProcessResult, type TaskPreviewSocket } from "../sandbox"
import { type ToolkitName, installToolkit } from "../sandbox/toolkits"
import { EventHub } from "./events"
import { AgentHarness, type AgentChoice } from "./harness"
import { formatHandoff } from "./handoff"
import { withUserContext } from "./user-context"
import { peerMessageText, type FromThread } from "./peer"
import { commandProvider } from "./command-provider"
import { newId, nowIso, StateStore, type StoreState } from "./state"
import { agentText, attachmentPath, sanitizeUploadName } from "./uploads"
import { parseRepoRef, type RepoRef } from "./repo-ref"
import { checkoutPinRef, WorkspaceService, type CheckoutSpec } from "./workspace"
import { STORAGE_CHECK_MS, STORAGE_GROWTH_SLACK, diskUsage, formatBytes } from "./storage"

const PREVIEW_SELECTOR_SCRIPT = `<script>(() => {
  const prefix = location.pathname.match(/^\\/_preview\\/[^/]+\\/[^/]+/)[0];
  const previewUrl = (value) => {
    const url = new URL(value, location.href);
    if (url.host !== location.host && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return value;
    url.host = location.host;
    if (!url.pathname.startsWith(prefix + "/")) url.pathname = prefix + url.pathname;
    return url.href;
  };
  const nativeFetch = window.fetch;
  window.fetch = (input, init) => nativeFetch(input instanceof Request ? new Request(previewUrl(input.url), input) : previewUrl(String(input)), init);
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { return nativeOpen.call(this, method, previewUrl(String(url)), ...rest); };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) { super(previewUrl(String(url)), protocols); }
  };
  let enabled = false;
  let hovered = null;
  const style = document.createElement("style");
  style.textContent = "[data-kestrel-preview-hover]{outline:2px solid #7c3aed!important;outline-offset:2px!important;cursor:crosshair!important}";
  document.documentElement.append(style);
  const selectorFor = (element) => {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      let part = node.localName;
      const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.localName === node.localName) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      if (node.id) { parts[0] = "#" + CSS.escape(node.id); break; }
    }
    return parts.join(" > ");
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "kestrel-preview-select-mode") return;
    enabled = event.data.enabled === true;
    document.documentElement.style.cursor = enabled ? "crosshair" : "";
    if (!enabled && hovered) { hovered.removeAttribute("data-kestrel-preview-hover"); hovered = null; }
  });
  document.addEventListener("pointerover", (event) => {
    if (!enabled || !(event.target instanceof Element)) return;
    if (hovered) hovered.removeAttribute("data-kestrel-preview-hover");
    hovered = event.target;
    hovered.setAttribute("data-kestrel-preview-hover", "");
  }, true);
  document.addEventListener("click", (event) => {
    if (!enabled || !(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target;
    const label = element.getAttribute("aria-label") || element.getAttribute("alt") || (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 160) || element.localName;
    const html = element.outerHTML.length > 2000 ? element.outerHTML.slice(0, 2000) + "…" : element.outerHTML;
    parent.postMessage({ type: "kestrel-preview-selection", label, selector: selectorFor(element), html, page: location.pathname }, "*");
    enabled = false;
    document.documentElement.style.cursor = "";
    if (hovered) { hovered.removeAttribute("data-kestrel-preview-hover"); hovered = null; }
  }, true);
})();</script>`

/** Bytes an agent attaches to a message (e.g. a desktop screenshot); core stores them and serves them over REST. */
export interface AttachmentInput {
  readonly mimeType: string
  readonly bytes: Uint8Array
}

/** A file the user uploads for a task's next message. */
export interface UploadInput {
  readonly mimeType: string
  readonly name?: string | undefined
  readonly bytes: Uint8Array
}

export interface ReportInput {
  readonly status: TaskStatus
  readonly message: string
  readonly attachments?: ReadonlyArray<AttachmentInput>
}

export interface OpenPullRequestInput {
  readonly title: string
  readonly body: string
  readonly draft: boolean
  /** Checkout to open the pull request from; required when the thread has several. */
  readonly checkoutId?: string
}

export interface ReviewPullRequestInput extends NewReview {
  /** Number of the pull request in the checkout's GitHub repository. */
  readonly number: number
  /** Checkout whose repository holds the pull request; required when the thread has several. */
  readonly checkoutId?: string
}

export interface OpenedPullRequest {
  readonly pullRequest: PullRequest
  /** False when an open pull request for the branch already existed and was returned instead. */
  readonly created: boolean
}

export interface AskInput {
  readonly question: string
  readonly options: ReadonlyArray<string>
  readonly attachments?: ReadonlyArray<AttachmentInput>
}

/** The question's wait ended without an answer because the run ended first. */
export class AskError extends Data.TaggedError("AskError")<{ readonly message: string }> {}

/** How a question's wait ended: the user's reply, or the run ended first. */
type AskOutcome = { readonly _tag: "answered"; readonly text: string } | { readonly _tag: "ended" }

export interface CoreShape {
  readonly health: () => Effect.Effect<void>

  // Every browser-facing operation takes the signed-in `user`. A thread and its runs, checkouts and desktop exist
  // only for the thread's owner: anyone else gets NotFound, never a hint it exists.
  /** Every thread of `user`, archived ones included, newest `updatedAt` first. */
  readonly listTasks: (user: string) => Effect.Effect<ReadonlyArray<Task>>
  /** Creates a thread; with `checkout`, the repository is checked out before this returns. */
  readonly createTask: (
    user: string,
    input: CreateTaskBody,
  ) => Effect.Effect<Task, BadRequest | Conflict | NotFound | InternalError>
  readonly getTask: (user: string, id: string) => Effect.Effect<Task, NotFound>
  /**
   * The commands the thread's next message can run, discovered from the authenticated harness in the thread
   * workspace. While a run is active the next message joins it, so the run's provider wins over `model`.
   */
  readonly commands: (
    user: string,
    id: string,
    model: AgentModel,
  ) => Effect.Effect<HarnessCommands, NotFound | BadRequest | InternalError>
  readonly deleteTask: (user: string, id: string) => Effect.Effect<void, NotFound | InternalError>
  /** Tears down the thread's runtime (running runs, desktop, sandbox) and hides it from the active list; history and workspace stay. */
  readonly archiveTask: (user: string, id: string) => Effect.Effect<Task, NotFound | InternalError>
  /** Lifts the archive; nothing restarts on its own. */
  readonly unarchiveTask: (user: string, id: string) => Effect.Effect<Task, NotFound | InternalError>
  /** One entry per checkout: everything on its branch and in its working tree, against its fork point. */
  readonly diff: (user: string, taskId: string) => Effect.Effect<DiffResponse, NotFound | InternalError>

  readonly listMessages: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Message>, NotFound>
  /**
   * Sends a chat message. `dev` marks a `/auth/dev-login` session: only then does a `/replay`
   * message play a recorded fixture instead of starting the agent.
   */
  readonly sendMessage: (
    user: string,
    taskId: string,
    text: string,
    choice: AgentChoice,
    attachmentIds: ReadonlyArray<string>,
    dev: boolean,
  ) => Effect.Effect<SendMessageResponse, NotFound | Conflict | BadRequest | InternalError>
  /**
   * Used by the MCP handler (`thread_send`): delivers an agent's message to another thread of the same owner. It joins
   * that thread's running run (read with task_inbox) or starts a run that resumes the thread's agent session. It never
   * answers the thread's open question: that stays for the user. Another owner's thread is NotFound.
   */
  readonly sendToThread: (
    fromTaskId: string,
    toTaskId: string,
    text: string,
  ) => Effect.Effect<SendMessageResponse, NotFound | Conflict | BadRequest | InternalError>

  readonly listRuns: (user: string, taskId: string) => Effect.Effect<ReadonlyArray<Run>, NotFound>
  /** Agent usage of `user` in the billing period (UTC calendar month) containing `now`. */
  readonly usage: (user: string, now: Date) => Effect.Effect<Usage>
  readonly cancelRun: (user: string, runId: string) => Effect.Effect<Run, NotFound | Conflict | InternalError>
  /** A run's display items; another user's run is NotFound, like every other owned route. */
  readonly runItems: (user: string, runId: string) => Effect.Effect<ReadonlyArray<AgentItem>, NotFound | InternalError>

  readonly desktopStatus: (user: string, taskId: string) => Effect.Effect<DesktopStatus, NotFound>
  readonly desktopStart: (user: string, taskId: string) => Effect.Effect<DesktopStatus, NotFound | Conflict | InternalError>
  readonly desktopStop: (user: string, taskId: string) => Effect.Effect<void, NotFound>
  /** Sets how the owner's live desktop is streamed; a desktop that is not running is a Conflict. */
  readonly desktopSetQuality: (
    user: string,
    taskId: string,
    quality: DesktopQuality,
  ) => Effect.Effect<DesktopStatus, NotFound | Conflict>
  /** Used by the MCP handler: starts the task's desktop, or returns the one already running. */
  readonly desktopOpen: (taskId: string) => Effect.Effect<DesktopStatus, NotFound | Conflict | InternalError>
  /** Used by the MCP handler: expose the agent's dev-server port in the browser preview. */
  readonly previewOpen: (taskId: string, runId: string, port: number) => Effect.Effect<Task, NotFound | Conflict | InternalError>

  /** Used by the MCP handler: a run's own status report. Fails unless `runId` is the task's running run. */
  readonly report: (taskId: string, runId: string, input: ReportInput) => Effect.Effect<void, NotFound | Conflict | BadRequest | InternalError>
  /** Used by the MCP handler: posts a question with options and waits for the user's answer. */
  readonly ask: (
    taskId: string,
    runId: string,
    input: AskInput,
  ) => Effect.Effect<string, NotFound | Conflict | BadRequest | InternalError | AskError>
  /** Used by the MCP handler: the agent-facing text of the run's user messages it has not seen yet; those messages are marked read. */
  readonly inbox: (taskId: string, runId: string) => Effect.Effect<ReadonlyArray<string>>
  /** An authenticated request to the task's registered loopback dev server. */
  readonly previewRequest: (user: string, taskId: string, request: Request) => Effect.Effect<Response, NotFound | Conflict | BadRequest | InternalError>
  /** Authenticated HMR socket for the task's registered preview port. */
  readonly previewSocket: (user: string, taskId: string, path: string, protocol?: string) => Effect.Effect<TaskPreviewSocket, NotFound | Conflict | InternalError>
  /** Bytes of an attachment on one of the signed-in user's task messages. */
  readonly attachment: (
    user: string,
    taskId: string,
    attachmentId: string,
  ) => Effect.Effect<{ readonly mimeType: string; readonly bytes: Uint8Array }, NotFound | InternalError>
  /** Stores a file the user uploads for one of the task's messages; it waits there, unsent, until a message names it. */
  readonly upload: (user: string, taskId: string, input: UploadInput) => Effect.Effect<Attachment, NotFound | Conflict | BadRequest | InternalError>
  /** Used by the MCP handler to authorize a run token: the run with this id, if it exists. */
  readonly runFor: (runId: string) => Effect.Effect<Run | null>
  /** Used by the MCP handler: runs a shell command at the thread workspace root. */
  readonly execInTask: (taskId: string, command: string, timeoutMs: number) => Effect.Effect<ProcessResult, NotFound | InternalError>
  /** Used by the MCP handler: starts a sandboxed app on the task's live desktop and returns its id. */
  readonly desktopLaunch: (taskId: string, command: string) => Effect.Effect<string, NotFound | InternalError>
  /** Used by the MCP handler (`toolkit_install`): builds a toolkit and puts its executables on the task's PATH; returns their names. */
  readonly toolkitInstall: (taskId: string, name: ToolkitName) => Effect.Effect<ReadonlyArray<string>, NotFound | InternalError>
  /** Used by the MCP handler (`repo_checkout`): checks a repository out into the thread. One checkout per repo; asking again returns it. */
  readonly checkout: (
    taskId: string,
    input: CheckoutRequest,
  ) => Effect.Effect<Checkout, NotFound | BadRequest | Conflict | InternalError>
  /** Used by the MCP handler: pushes a checkout's branch to its GitHub remote (never forced). Returns the branch. */
  readonly gitPush: (taskId: string, checkoutId?: string) => Effect.Effect<string, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: pushes the checkout's branch and opens its pull request, or returns the open one. */
  readonly openPullRequest: (
    taskId: string,
    input: OpenPullRequestInput,
  ) => Effect.Effect<OpenedPullRequest, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: live GitHub status of a checkout's pull request. */
  readonly pullRequestStatus: (
    taskId: string,
    checkoutId?: string,
  ) => Effect.Effect<PullRequestStatus, NotFound | BadRequest | InternalError>
  /** Used by the MCP handler: posts a review on a pull request of a checkout's GitHub repository. APPROVE is never sent. */
  readonly reviewPullRequest: (
    taskId: string,
    input: ReviewPullRequestInput,
  ) => Effect.Effect<PostedReview, NotFound | BadRequest | InternalError>
  /** Used by the automations: the user a thread belongs to, whom its automations act for. */
  readonly taskOwner: (taskId: string) => Effect.Effect<string, NotFound>
  /** Bytes the thread's files took at the last storage check; null before its first check. */
  readonly storageUsed: (taskId: string) => number | null

  /** Cancels active runs, stops desktops and tears down task networks. */
  readonly shutdown: () => Effect.Effect<void>
}

export class CoreService extends Context.Tag("cloudagents/CoreService")<CoreService, CoreShape>() {}

const toInternal = (what: string) => (e: { readonly message: string }) =>
  new InternalError({ message: `${what}: ${e.message}` })

const fromGitHub = (e: GitHubError) => new InternalError({ message: e.message })

const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug === "" ? "task" : slug
}

/** `name`, or `name-2`, `name-3`, ... when a checkout of the thread already uses it. */
const freeDirName = (taken: ReadonlyArray<string>, name: string): string => {
  let candidate = name
  for (let n = 2; taken.includes(candidate); n++) candidate = `${name}-${n}`
  return candidate
}

/** Validates a checkout request before anything is created for it. */
const parseCheckoutRequest = (request: CheckoutRequest): Effect.Effect<RepoRef, BadRequest> => {
  const ref = parseRepoRef(request.repo)
  if (ref === null) {
    return Effect.fail(
      new BadRequest({ message: "repo must be owner/name on github.com or an https clone URL" }),
    )
  }
  if (request.pullRequest !== undefined && ref.github === null) {
    return Effect.fail(new BadRequest({ message: `${ref.repo} is not a github.com repository; pull requests need one` }))
  }
  return Effect.succeed(ref)
}

/** The repository a stored checkout names. Stored values were validated on the way in. */
const checkoutRepoRef = (checkout: Checkout): Effect.Effect<RepoRef, InternalError> => {
  const ref = parseRepoRef(checkout.repo)
  return ref === null
    ? Effect.fail(new InternalError({ message: `checkout ${checkout.id} has an invalid repo ${checkout.repo}` }))
    : Effect.succeed(ref)
}

/** The checkout a tool call means: the one it names, or the thread's only checkout. */
const pickCheckout = (task: Task, checkoutId: string | undefined): Effect.Effect<Checkout, NotFound | BadRequest> => {
  if (checkoutId !== undefined) {
    const found = task.checkouts.find((c) => c.id === checkoutId)
    return found
      ? Effect.succeed(found)
      : Effect.fail(new NotFound({ message: `checkout ${checkoutId} not found in this thread` }))
  }
  const [only] = task.checkouts
  if (task.checkouts.length === 0) {
    return Effect.fail(new BadRequest({ message: "this thread has no checkouts; call repo_checkout first" }))
  }
  if (task.checkouts.length === 1 && only) return Effect.succeed(only)
  const ids = task.checkouts.map((c) => `${c.id} (${c.repo})`).join(", ")
  return Effect.fail(new BadRequest({ message: `this thread has several checkouts; pass checkout as one of: ${ids}` }))
}

/** Recorded harness transcripts (dev-only `/replay`): packages/server/fixtures/agent/<harness>/<name>.jsonl. */
const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures", "agent")
const FIXTURE_HARNESSES = ["claude", "codex"] as const
/** A chat message that is a replay command: `/replay` alone or followed by whitespace and a target. */
const REPLAY_COMMAND = /^\/replay(\s|$)/
const REPLAY_TARGET = /^(claude|codex)\/[a-z0-9-]+$/

/** Fixture names on disk, as `harness/name`; a harness with no directory yet simply has none. */
const availableFixtures = (): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const names: string[] = []
    for (const harness of FIXTURE_HARNESSES) {
      const files = await readdir(join(FIXTURES_DIR, harness)).catch(() => [])
      for (const file of files) {
        if (file.endsWith(".jsonl")) names.push(`${harness}/${file.slice(0, -".jsonl".length)}`)
      }
    }
    return names.sort()
  })

/** The fixture a `/replay <harness>/<name>` message names, or BadRequest listing what exists. */
const replayFixturePath = (text: string): Effect.Effect<string, BadRequest> =>
  Effect.gen(function* () {
    const target = text.trim().slice("/replay".length).trim()
    const available = yield* availableFixtures()
    if (REPLAY_TARGET.test(target) && available.includes(target)) {
      return join(FIXTURES_DIR, `${target}.jsonl`)
    }
    return yield* Effect.fail(
      new BadRequest({
        message: `unknown fixture "${target}"; available: ${available.length === 0 ? "none" : available.join(", ")}`,
      }),
    )
  })

export const CoreLive = Layer.effect(
  CoreService,
  Effect.gen(function* () {
    const config = yield* Config
    const store = yield* StateStore
    const hub = yield* EventHub
    const harness = yield* AgentHarness
    const desktop = yield* DesktopManager
    const workspace = yield* WorkspaceService
    const credentials = yield* CredentialStore
    const github = yield* GitHub
    const cliAuth = yield* CliAuth
    const sandboxSettings = sandboxSettingsOf(config)
    /** One checkout at a time: they all refresh mirrors, which are shared by every checkout of one owner. */
    const checkoutLock = yield* Effect.makeSemaphore(1)

    // Desktop status changes are pushed to every task's event stream.
    yield* desktop.watchStatus((desktopStatus) => hub.publish({ _tag: "desktop.updated", desktop: desktopStatus }))

    const threadDirOf = (taskId: string) => join(config.threadsDir, taskId)
    const shadowPathOf = (taskId: string, checkoutId: string) => join(config.shadowsDir, taskId, `${checkoutId}.git`)
    const checkoutSpec = (taskId: string, checkout: Checkout): CheckoutSpec => {
      const threadDir = threadDirOf(taskId)
      return { threadDir, dir: join(threadDir, checkout.dir), shadowPath: shadowPathOf(taskId, checkout.id) }
    }

    /** Every agent-controlled process goes through here: bubblewrap inside the task's systemd slice. */
    const launchFor = (task: Task, kind: LaunchKind, display: string | null, command: string) =>
      prepareLaunch({
        settings: sandboxSettings,
        taskId: task.id,
        kind,
        workspacePath: threadDirOf(task.id),
        mirrorDir: join(config.mirrorsDir, task.owner),
        homeDir: join(config.homesDir, task.id),
        display,
        env: { CLOUDAGENTS_TASK_ID: task.id },
        command,
      })

    /** The desktop's terminal runs in the sandbox too: the agent can type into it. */
    const startDesktop = (task: Task) =>
      desktop.start(task.id, {
        terminal: (display) =>
          launchFor(task, "desktop", display, "exec xterm -geometry 100x30+40+40 -e bash").pipe(
            Effect.mapError((e) => new DesktopError({ message: e.message })),
          ),
        ipcNamespace: desktopNamespace(sandboxSettings, task.id).pipe(
          Effect.mapError((e) => new DesktopError({ message: e.message })),
        ),
      })

    const findTask = (state: Readonly<StoreState>, taskId: string) =>
      Either.fromNullable(
        state.tasks.find((t) => t.id === taskId),
        () => new NotFound({ message: `task ${taskId} not found` }),
      )

    const requireTask = (taskId: string): Effect.Effect<Task, NotFound> =>
      Effect.flatMap(store.read, (state) => Either.match(findTask(state, taskId), {
        onLeft: (e) => Effect.fail(e),
        onRight: (t) => Effect.succeed({ ...t }),
      }))

    const ownsTask = (state: Readonly<StoreState>, user: string, taskId: string): boolean =>
      state.tasks.some((t) => t.id === taskId && t.owner === user)

    /** A thread of `user`; anything else is NotFound. */
    const ownedTask = (user: string, taskId: string): Effect.Effect<Task, NotFound> =>
      Effect.flatMap(store.read, (state) =>
        ownsTask(state, user, taskId) ? requireTask(taskId) : Effect.fail(new NotFound({ message: `task ${taskId} not found` })),
      )

    const requireRun = (runId: string): Effect.Effect<Run, NotFound> =>
      Effect.flatMap(store.read, (state) => {
        const run = state.runs.find((r) => r.id === runId)
        return run ? Effect.succeed({ ...run }) : Effect.fail(new NotFound({ message: `run ${runId} not found` }))
      })

    const publishMessage = (message: Message) => hub.publish({ _tag: "message.created", message })

    /** The owner's GitHub token, or undefined when they have not connected GitHub. It never reaches a sandbox. */
    const githubTokenOf = (owner: string): Effect.Effect<string | undefined> =>
      Effect.map(credentials.get(owner), (creds) => creds?.github || undefined)

    const requiredGithubToken = (owner: string): Effect.Effect<string, BadRequest> =>
      Effect.flatMap(githubTokenOf(owner), (token) =>
        token === undefined
          ? Effect.fail(
              new BadRequest({ message: "no GitHub connection for this account: connect GitHub under Connections, then retry" }),
            )
          : Effect.succeed(token),
      )

    /** owner/name of a github.com repo plus the owner's token; pull request tools need both. */
    const githubAccess = (owner: string, ref: RepoRef): Effect.Effect<{ readonly slug: RepoSlug; readonly token: string }, BadRequest> =>
      Effect.gen(function* () {
        if (ref.github === null) {
          return yield* Effect.fail(new BadRequest({ message: `${ref.repo} is not a github.com repository; pull requests need one` }))
        }
        return { slug: ref.github, token: yield* requiredGithubToken(owner) }
      })

    /** Pushes the checkout's branch from its shadow repo (never forced). The token is set for github.com remotes only. */
    const pushCheckout = (task: Task, checkout: Checkout): Effect.Effect<void, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const ref = yield* checkoutRepoRef(checkout)
        const token = ref.github === null ? undefined : yield* requiredGithubToken(task.owner)
        const spec = checkoutSpec(task.id, checkout)
        const head = yield* workspace.headSha(spec).pipe(Effect.mapError(toInternal("read checkout head")))
        yield* workspace
          .pushBranch({ ...spec, url: ref.url, branch: checkout.branch, head, githubToken: token })
          .pipe(Effect.mapError(toInternal("push")))
      })

    /** Stores the pull request on the checkout; `announce` also posts a chat note (used when it was just opened). */
    const recordPullRequest = (taskId: string, checkoutId: string, link: PullRequestLink, announce: boolean) =>
      Effect.gen(function* () {
        const updated = yield* store.update(
          (s): Either.Either<{ task: Task; message: Message | null }, NotFound> => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const task = found.right
            const checkout = task.checkouts.find((c) => c.id === checkoutId)
            if (!checkout) return Either.left(new NotFound({ message: `checkout ${checkoutId} not found in this thread` }))
            const now = nowIso()
            task.checkouts = task.checkouts.map((c) => (c.id === checkoutId ? { ...c, pullRequest: link } : c))
            task.updatedAt = now
            let message: Message | null = null
            if (announce) {
              message = {
                id: newId(),
                taskId,
                role: "system",
                text: `Opened pull request #${link.number} for ${checkout.repo}: ${link.url}`,
                runId: null,
                createdAt: now,
              }
              s.messages.push(message)
            }
            return Either.right({ task: { ...task }, message })
          },
        )
        hub.publish({ _tag: "task.updated", task: updated.task })
        if (updated.message) publishMessage(updated.message)
      })

    /** Live `task_ask` calls by run, each waiting for the user's answer. A question persists in `pendingAsks` regardless. */
    const liveAsks = new Map<string, Deferred.Deferred<AskOutcome>>()
    /** User messages each run has taken, from its inbox or as an answer. Forgotten once the run ends. */
    const seenByRun = new Map<string, Set<string>>()
    const seenFor = (runId: string): Set<string> => {
      const seen = seenByRun.get(runId) ?? new Set<string>()
      seenByRun.set(runId, seen)
      return seen
    }

    /** Writes attachment bytes under the attachments dir; the message only carries their metadata. */
    const storeAttachments = (
      inputs: ReadonlyArray<AttachmentInput> | undefined,
    ): Effect.Effect<Attachment[], BadRequest | InternalError> => {
      const oversize = (inputs ?? []).find((input) => input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
      if (oversize) {
        return Effect.fail(
          new BadRequest({ message: `attachment is ${oversize.bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}` }),
        )
      }
      return Effect.forEach(inputs ?? [], (input) => {
        const id = newId()
        return Effect.tryPromise({
          try: () => writeFile(join(config.attachmentsDir, id), input.bytes),
          catch: (e) => new InternalError({ message: `store attachment: ${String(e)}` }),
        }).pipe(Effect.as({ id, mimeType: input.mimeType }))
      })
    }

    /** Checks that each id is a pending upload of `taskId`, named once. Returns the attachments in the order named. */
    const pendingUploads = (
      s: Readonly<StoreState>,
      taskId: string,
      ids: ReadonlyArray<string>,
    ): Either.Either<Attachment[], BadRequest> => {
      const picked: Attachment[] = []
      for (const id of ids) {
        if (picked.some((a) => a.id === id)) return Either.left(new BadRequest({ message: `attachment ${id} is named twice` }))
        const upload = s.uploads.find((u) => u.id === id && u.taskId === taskId)
        if (!upload) return Either.left(new BadRequest({ message: `attachment ${id} is not a pending upload of this task` }))
        picked.push({ id: upload.id, mimeType: upload.mimeType, name: upload.name })
      }
      return Either.right(picked)
    }

    /** Every attachment file of a thread: its pending uploads and the files on its messages (user's and agent's). */
    const attachmentIdsOf = (s: Readonly<StoreState>, taskId: string): string[] => [
      ...s.messages.filter((m) => m.taskId === taskId).flatMap((m) => (m.attachments ?? []).map((a) => a.id)),
      ...s.uploads.filter((u) => u.taskId === taskId).map((u) => u.id),
    ]

    const removeTaskState = (taskId: string) =>
      Effect.gen(function* () {
        const attachmentIds = yield* store.update((s): Either.Either<string[], never> => {
          const ids = attachmentIdsOf(s, taskId)
          const runIds = new Set(s.runs.filter((r) => r.taskId === taskId).map((r) => r.id))
          s.tasks = s.tasks.filter((t) => t.id !== taskId)
          s.messages = s.messages.filter((m) => m.taskId !== taskId)
          s.runs = s.runs.filter((r) => r.taskId !== taskId)
          s.pendingAsks = s.pendingAsks.filter((a) => a.taskId !== taskId)
          s.uploads = s.uploads.filter((u) => u.taskId !== taskId)
          s.runSessions = s.runSessions.filter((x) => !runIds.has(x.runId))
          return Either.right(ids)
        })
        yield* Effect.forEach(
          attachmentIds,
          (id) =>
            Effect.tryPromise(() => rm(join(config.attachmentsDir, id), { force: true })).pipe(
              Effect.catchAll((e) => Effect.logWarning(`attachment ${id}: ${String(e)}`)),
            ),
          { discard: true },
        )
      })

    /**
     * Stops everything a thread runs on the box: its running runs, its desktop (and the apps on it), its network
     * namespace and its systemd slice. Archiving and deleting both start here.
     */
    const teardownRuntime = (taskId: string) =>
      Effect.gen(function* () {
        const state = yield* store.read
        for (const run of state.runs) {
          if (run.taskId === taskId && run.status === "running") {
            yield* harness.cancel(run.id)
          }
        }
        yield* desktop.stop(taskId)
        stopTaskNet(taskId)
        if (sandboxSettings.systemd) {
          yield* removeTask(sandboxSettings.systemd, taskId).pipe(
            Effect.catchAll((e) => Effect.logWarning(`task ${taskId}: ${e.message}`)),
          )
        }
      })

    /**
     * Bytes each thread's files took at the last storage check: workspace, home, shadow repos and its attachment files
     * (pending uploads included). Uploads add their bytes as they arrive, so the count is never behind on them.
     */
    const storageUsed = new Map<string, number>()
    /** Upload bytes added while a thread's check is walking its files; added to the walk's total so none is lost. */
    const uploadedDuringCheck = new Map<string, number>()
    const storageRootsOf = (s: Readonly<StoreState>, taskId: string) => [
      threadDirOf(taskId),
      join(config.homesDir, taskId),
      join(config.shadowsDir, taskId),
      ...attachmentIdsOf(s, taskId).map((id) => join(config.attachmentsDir, id)),
    ]
    /** Set while the thread is over `taskDiskMax`: uploads and checkouts are refused, and runs are told to clean up. */
    const overStorage = (taskId: string): number | null => {
      const used = storageUsed.get(taskId)
      return used !== undefined && used > config.taskDiskMax ? used : null
    }
    const refuseOverStorage = (taskId: string): Effect.Effect<void, Conflict> => {
      const used = overStorage(taskId)
      return used === null
        ? Effect.void
        : Effect.fail(
            new Conflict({
              message: `this thread is over its storage limit (${formatBytes(used)} of ${formatBytes(config.taskDiskMax)}); delete files first`,
            }),
          )
    }

    /**
     * Measures every thread's files and enforces `taskDiskMax`: a thread over the limit that is still growing (by more
     * than `STORAGE_GROWTH_SLACK` since the last check) while something runs has its runtime stopped, and the chat says
     * why. A thread over the limit but shrinking keeps running, so a run can delete files to get back under.
     */
    const checkStorage = Effect.gen(function* () {
      const state = yield* store.read
      for (const task of state.tasks) {
        uploadedDuringCheck.set(task.id, 0)
        const measured = yield* Effect.promise(() => diskUsage(storageRootsOf(state, task.id)))
        // An upload that lands during the walk may or may not be in `measured`; counting it again errs on the safe side.
        const used = measured + (uploadedDuringCheck.get(task.id) ?? 0)
        uploadedDuringCheck.delete(task.id)
        const previous = storageUsed.get(task.id)
        storageUsed.set(task.id, used)
        if (task.archivedAt !== undefined || used <= config.taskDiskMax) continue
        if (previous !== undefined && used <= previous + STORAGE_GROWTH_SLACK) continue
        const running = state.runs.some((r) => r.taskId === task.id && r.status === "running")
        const desktopNow = yield* desktop.status(task.id)
        if (!running && desktopNow.state === "stopped") continue
        yield* Effect.logWarning(`task ${task.id}: over its storage limit (${used} bytes) and growing; stopping its runtime`)
        yield* teardownRuntime(task.id)
        const message: Message = {
          id: newId(),
          taskId: task.id,
          role: "system",
          text: `Stopped the agent and the desktop: this thread's files take ${formatBytes(used)}, over its ${formatBytes(config.taskDiskMax)} storage limit, and were still growing. Ask the agent to delete files it no longer needs; while the thread is over the limit, anything that keeps growing it is stopped again.`,
          runId: null,
          createdAt: nowIso(),
        }
        yield* store.update((s): Either.Either<void, never> => {
          s.messages.push(message)
          return Either.right(undefined)
        })
        publishMessage(message)
      }
      for (const id of storageUsed.keys()) {
        if (!state.tasks.some((t) => t.id === id)) storageUsed.delete(id)
      }
    })

    const deleteTask = (taskId: string): Effect.Effect<void, NotFound | InternalError> =>
      Effect.gen(function* () {
        const task = yield* requireTask(taskId)
        yield* teardownRuntime(taskId)
        yield* workspace.removePath(threadDirOf(taskId)).pipe(Effect.mapError(toInternal("remove workspace")))
        yield* workspace.removePath(join(config.shadowsDir, taskId)).pipe(Effect.mapError(toInternal("remove shadow repos")))
        yield* workspace.removePath(join(config.homesDir, taskId)).pipe(Effect.mapError(toInternal("remove thread home")))
        yield* removeTaskState(taskId)
        hub.publish({ _tag: "task.deleted", taskId, owner: task.owner })
      })

    // Archiving sets the flag before teardown, so no run can start while the runtime is being torn down.
    const archiveTask: CoreShape["archiveTask"] = (user, id) =>
      Effect.gen(function* () {
        yield* ownedTask(user, id)
        const archived = yield* store.update((s): Either.Either<Task, NotFound> => {
          const found = findTask(s, id)
          if (Either.isLeft(found)) return Either.left(found.left)
          const task = found.right
          if (task.archivedAt === undefined) {
            task.archivedAt = nowIso()
            task.updatedAt = task.archivedAt
          }
          return Either.right({ ...task })
        })
        hub.publish({ _tag: "task.updated", task: archived })
        yield* teardownRuntime(id)
        return archived
      })

    const unarchiveTask: CoreShape["unarchiveTask"] = (user, id) =>
      Effect.gen(function* () {
        yield* ownedTask(user, id)
        const restored = yield* store.update((s): Either.Either<Task, NotFound> => {
          const found = findTask(s, id)
          if (Either.isLeft(found)) return Either.left(found.left)
          const task = found.right
          if (task.archivedAt !== undefined) {
            delete task.archivedAt
            task.updatedAt = nowIso()
          }
          return Either.right({ ...task })
        })
        hub.publish({ _tag: "task.updated", task: restored })
        return restored
      })

    /**
     * Checks a repository out into a thread: refreshes the owner's mirror, clones it into the workspace on a new branch
     * and pins the fork point in the checkout's shadow repo. A repo already checked out in the thread returns that checkout.
     */
    const addCheckout = (
      taskId: string,
      request: CheckoutRequest,
    ): Effect.Effect<Checkout, NotFound | BadRequest | Conflict | InternalError> =>
      checkoutLock.withPermits(1)(
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          if (task.archivedAt !== undefined) {
            return yield* Effect.fail(new Conflict({ message: "task is archived; unarchive it first" }))
          }
          yield* refuseOverStorage(taskId)
          const ref = yield* parseCheckoutRequest(request)
          const existing = task.checkouts.find((c) => c.repo === ref.repo)
          if (existing) return existing
          const checkout = yield* cloneCheckout(task, request, ref)
          const updated = yield* store.update((s): Either.Either<Task, NotFound> => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const stored = found.right
            stored.checkouts = [...stored.checkouts, checkout]
            stored.updatedAt = nowIso()
            return Either.right({ ...stored })
          })
          hub.publish({ _tag: "task.updated", task: updated })
          return checkout
        }),
      )

    /** Clones the repo's mirror into a new checkout dir of `task`. Runs under `checkoutLock`; removes what it made on failure. */
    const cloneCheckout = (
      task: Task,
      request: CheckoutRequest,
      ref: RepoRef,
    ): Effect.Effect<Checkout, BadRequest | InternalError> => {
      const id = newId()
      const threadDir = threadDirOf(task.id)
      const dir = freeDirName(
        task.checkouts.map((c) => c.dir),
        ref.name,
      )
      const removeOnFailure = Effect.ignore(
        Effect.all([workspace.removePath(join(threadDir, dir)), workspace.removePath(shadowPathOf(task.id, id))], {
          discard: true,
        }),
      )
      return Effect.gen(function* () {
        const spec: CheckoutSpec = { threadDir, dir: join(threadDir, dir), shadowPath: shadowPathOf(task.id, id) }
        const mirrorPath = join(config.mirrorsDir, task.owner, ref.mirrorRel)
        // Only github.com remotes ever receive the owner's token.
        const token = ref.github === null ? undefined : yield* githubTokenOf(task.owner)
        const target = { mirrorPath, url: ref.url, githubToken: token }
        const pullRequest = request.pullRequest
        const fork = yield* Effect.gen(function* () {
          if (pullRequest === undefined) {
            const defaultBranch = yield* workspace.syncMirror(target).pipe(Effect.mapError(toInternal("fetch repo")))
            const baseBranch = request.baseBranch ?? defaultBranch
            const sha = yield* workspace
              .resolveRef(mirrorPath, `refs/heads/${baseBranch}`)
              .pipe(Effect.mapError(toInternal("resolve base branch")))
            if (sha === null) {
              return yield* Effect.fail(new BadRequest({ message: `branch ${baseBranch} not found in ${ref.repo}` }))
            }
            return { baseBranch, startSha: sha }
          }
          // The checkout starts at the pull request's head; its base is the pull request's base unless named.
          const access = yield* githubAccess(task.owner, ref)
          const status = yield* github
            .getPullRequestStatus(access.token, access.slug, pullRequest)
            .pipe(Effect.mapError(fromGitHub))
          yield* workspace.syncMirror(target).pipe(Effect.mapError(toInternal("fetch repo")))
          const sha = yield* workspace
            .fetchPullRequest({ ...target, githubToken: access.token, number: pullRequest })
            .pipe(Effect.mapError(toInternal("fetch pull request")))
          return { baseBranch: request.baseBranch ?? status.baseRef, startSha: sha }
        })
        const branch = `cloudagents/${slugify(task.title)}-${task.id.replace(/-/g, "").slice(0, 6)}`
        yield* workspace
          .createCheckout({
            ...spec,
            mirrorPath,
            url: ref.url,
            branch,
            startSha: fork.startSha,
            baseSha: fork.startSha,
            pinRef: checkoutPinRef(task.id, id),
          })
          .pipe(Effect.mapError(toInternal("create checkout")))
        return { id, repo: ref.repo, dir, branch, baseBranch: fork.baseBranch, createdAt: nowIso() }
      }).pipe(Effect.tapError(() => removeOnFailure))
    }

    const createTask: CoreShape["createTask"] = (user, input) =>
      Effect.gen(function* () {
        const title = input.title?.trim() || "Untitled task"
        const request = input.checkout
        if (request !== undefined) yield* parseCheckoutRequest(request)
        const id = newId()
        const now = nowIso()
        const task: Task = { id, owner: user, title, status: "idle", createdAt: now, updatedAt: now, checkouts: [] }
        yield* Effect.tryPromise({
          try: () => mkdir(threadDirOf(id), { recursive: true }),
          catch: (e) => new InternalError({ message: `create workspace: ${String(e)}` }),
        })
        yield* store.update((s): Either.Either<void, never> => {
          s.tasks.push(task)
          return Either.right(undefined)
        })
        hub.publish({ _tag: "task.updated", task })
        if (request !== undefined) {
          // A checkout that fails leaves no thread behind: the request is all-or-nothing from the caller's view.
          yield* addCheckout(id, request).pipe(Effect.tapError(() => deleteTask(id).pipe(Effect.ignore)))
        }
        return yield* requireTask(id)
      })

    /** The text an agent reads for a message: the user's words with their uploads, or another agent's, framed as such. */
    const deliveredText = (taskId: string, m: Pick<Message, "text" | "attachments" | "fromThread">): string => {
      const typed = agentText(m.text, m.attachments ?? [], agentHome(sandboxSettings, join(config.homesDir, taskId)))
      return m.fromThread === undefined ? typed : peerMessageText(m.fromThread, typed)
    }

    /** Box notes for a new run's preamble: while the thread is over its storage limit, the run is asked to clean up. */
    const runNotes = (taskId: string): string[] => {
      const over = overStorage(taskId)
      if (over === null) return []
      return [
        `This thread's files (workspace, home and git data) take ${formatBytes(over)}, over the thread's ${formatBytes(config.taskDiskMax)} storage limit. Delete files you no longer need (build output, caches, downloads) before anything else. Uploads and new checkouts are refused until it is under the limit, and anything that keeps growing it is stopped.`,
      ]
    }

    /** A message to a thread: from its user (`from` null), or from the agent of another of the owner's threads. */
    const deliverMessage = (
      user: string,
      taskId: string,
      text: string,
      choice: AgentChoice,
      attachmentIds: ReadonlyArray<string>,
      dev: boolean,
      from: FromThread | null,
    ): Effect.Effect<SendMessageResponse, NotFound | Conflict | BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* ownedTask(user, taskId)
        const provider = choice.model === undefined ? DEFAULT_MODEL_PROVIDER : modelInfo(choice.model).provider
        if (text.trim() === "" && attachmentIds.length === 0) {
          return yield* Effect.fail(new BadRequest({ message: "message text or an attachment is required" }))
        }
        // Dev-only: `/replay` names a recorded transcript. Every other message (and every replay
        // attempt by a non-dev session) starts the agent as usual. Checked before anything is
        // reserved, so a bad fixture leaves no run or message behind.
        const replayFixture =
          dev && REPLAY_COMMAND.test(text.trim()) ? yield* replayFixturePath(text) : null
        // The files reach the task home before the message can, so the agent finds them when it reads the message.
        const uploads = yield* Effect.flatMap(store.read, (state) => {
          const picked = pendingUploads(state, taskId, attachmentIds)
          return Either.isLeft(picked) ? Effect.fail(picked.left) : Effect.succeed(picked.right)
        })
        yield* Effect.forEach(
          uploads,
          (a) =>
            Effect.tryPromise({
              try: async () => {
                const dest = attachmentPath(join(config.homesDir, taskId), a)
                await mkdir(dirname(dest), { recursive: true })
                await copyFile(join(config.attachmentsDir, a.id), dest)
              },
              catch: (e) => new InternalError({ message: `place upload ${a.id}: ${String(e)}` }),
            }),
          { discard: true },
        )
        const reserved = yield* store.update(
          (
            s,
          ): Either.Either<
            {
              task: Task
              message: Message
              run: Run
              answer: Deferred.Deferred<AskOutcome> | null
              start: { readonly prompt: string; readonly resumeSession: string | null } | null
              delivered: string
            },
            NotFound | Conflict | BadRequest
          > => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            const task = found.right
            if (task.archivedAt !== undefined) {
              return Either.left(new Conflict({ message: "task is archived; unarchive it first" }))
            }
            // A replay needs its own run: it must not land in a running run's inbox or answer its
            // question. Refused here, inside the same update that checks for a running run.
            if (replayFixture !== null && s.runs.some((r) => r.taskId === taskId && r.status === "running")) {
              return Either.left(new Conflict({ message: "a run is already in progress for this task" }))
            }
            const picked = pendingUploads(s, taskId, attachmentIds)
            if (Either.isLeft(picked)) return Either.left(picked.left)
            const attachments = picked.right
            s.uploads = s.uploads.filter((u) => !attachmentIds.includes(u.id))
            const sent = from === null ? {} : { fromThread: from }
            const delivered = deliveredText(taskId, { text, attachments, ...sent })
            const attached = attachments.length === 0 ? {} : { attachments }
            const now = nowIso()
            // Any message of the user settles the task's question: it is the answer, or it is ignored once the question's
            // run is gone. Another agent's message leaves the question to the user.
            const ask = from === null ? (s.pendingAsks.find((a) => a.taskId === taskId) ?? null) : null
            if (from === null) s.pendingAsks = s.pendingAsks.filter((a) => a.taskId !== taskId)
            const running = s.runs.find((r) => r.taskId === taskId && r.status === "running")
            if (running) {
              // Mid-run: the text joins the running run. If that run's call is still waiting on the question, it is
              // the answer; otherwise it waits in the run's inbox for task_inbox.
              const message: Message = { id: newId(), taskId, role: "user", text, runId: running.id, createdAt: now, ...attached, ...sent }
              const answer = ask?.runId === running.id ? (liveAsks.get(running.id) ?? null) : null
              if (answer) {
                liveAsks.delete(running.id)
                seenFor(running.id).add(message.id)
              }
              if (task.status === "needs_input" && from === null) task.status = "running"
              task.updatedAt = now
              s.messages.push(message)
              return Either.right({ task: { ...task }, message, run: { ...running }, answer, delivered, start: null })
            }
            // No run is going. The new run continues the agent session of the task's latest run, so the agent keeps the
            // thread's context. Only the latest run counts: a resume that failed before naming its session makes the next
            // run start fresh instead of retrying the same broken session forever. A session belongs to one provider's
            // CLI, so when the latest run ran on the other provider this run starts fresh and carries the conversation.
            const question = ask ? (s.messages.find((m) => m.id === ask.messageId)?.text ?? "") : null
            const latest = s.runs.filter((r) => r.taskId === taskId).at(-1)
            const latestSession = latest ? s.runSessions.find((x) => x.runId === latest.id) : undefined
            const resumeSession = latestSession?.provider === provider ? latestSession.sessionId : null
            const earlier =
              latestSession !== undefined && latestSession.provider !== provider
                ? s.messages.filter((m) => m.taskId === taskId)
                : null
            const run: Run = {
              id: newId(),
              taskId,
              prompt: text,
              status: "running",
              startedAt: now,
              endedAt: null,
              exitCode: null,
              provider,
            }
            const message: Message = { id: newId(), taskId, role: "user", text, runId: run.id, createdAt: now, ...attached, ...sent }
            task.status = "running"
            task.updatedAt = now
            s.runs.push(run)
            s.messages.push(message)
            // The prompt is what the run starts with, not mail for its inbox.
            seenFor(run.id).add(message.id)
            const asked =
              question === null
                ? delivered
                : `You asked the user: ${question}\nThe user answered: ${delivered}\nContinue the task from there.`
            const prompt = withUserContext(user, earlier === null ? asked : formatHandoff(earlier, asked), runNotes(taskId))
            return Either.right({
              task: { ...task },
              message,
              run: { ...run },
              answer: null,
              delivered,
              start: { prompt, resumeSession },
            })
          },
        )
        hub.publish({ _tag: "task.updated", task: reserved.task })
        publishMessage(reserved.message)
        if (reserved.answer) yield* Deferred.succeed(reserved.answer, { _tag: "answered", text: reserved.delivered })
        if (reserved.start === null) return { message: reserved.message, run: reserved.run }
        hub.publish({ _tag: "run.updated", run: reserved.run })

        const taskNow = yield* requireTask(taskId)

        // Archiving may have landed since the run was reserved: it cancelled this run and tore the task down,
        // so nothing may be spawned, and a desktop started meanwhile goes too.
        const stateNow = yield* store.read
        const runNow = stateNow.runs.find((r) => r.id === reserved.run.id)
        const archived = stateNow.tasks.find((t) => t.id === taskId)?.archivedAt !== undefined
        if (archived || runNow?.status !== "running") {
          if (archived) yield* desktop.stop(taskId)
          return { message: reserved.message, run: runNow ?? reserved.run }
        }

        // A replay plays a fixture on the host: no desktop, no agent session to resume and no choice.
        if (replayFixture !== null) {
          yield* harness.replay(taskNow, reserved.run, replayFixture)
          return { message: reserved.message, run: reserved.run }
        }

        // The desktop is not started with the run: the agent opens it with desktop_open when it needs one. A desktop the
        // user already has running is passed on, so the run's sandbox can reach it.
        const desktopNow = yield* desktop.status(taskId)
        const display = desktopNow.state === "running" ? desktopNow.display : null
        yield* harness.spawn(taskNow, reserved.run, reserved.start.prompt, display, user, reserved.start.resumeSession, choice)
        return { message: reserved.message, run: reserved.run }
      })

    const sendMessage: CoreShape["sendMessage"] = (user, taskId, text, choice, attachmentIds, dev) =>
      deliverMessage(user, taskId, text, choice, attachmentIds, dev, null)

    /**
     * The choice a run started by another agent's message runs with: the provider of the thread's latest session, so
     * that session resumes, on the provider's default model (the box default for the default provider).
     */
    const resumeChoice = (state: Readonly<StoreState>, taskId: string): AgentChoice => {
      const latest = state.runs.filter((r) => r.taskId === taskId).at(-1)
      const provider = (latest && state.runSessions.find((x) => x.runId === latest.id)?.provider) ?? DEFAULT_MODEL_PROVIDER
      if (provider === DEFAULT_MODEL_PROVIDER) return {}
      const model = providerModels(provider).find((m) => m.shownByDefault)?.id
      return model === undefined ? {} : { model }
    }

    const sendToThread: CoreShape["sendToThread"] = (fromTaskId, toTaskId, text) =>
      Effect.gen(function* () {
        const state = yield* store.read
        const sender = yield* findTask(state, fromTaskId)
        if (toTaskId === fromTaskId) {
          return yield* Effect.fail(new BadRequest({ message: "that is this thread; name another thread" }))
        }
        const from = { id: sender.id, title: sender.title }
        return yield* deliverMessage(sender.owner, toTaskId, text, resumeChoice(state, toTaskId), [], false, from)
      })

    /** Posts a question for the running run and waits for the user's answer. The question persists until it is answered. */
    const ask: CoreShape["ask"] = (taskId, runId, input) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<AskOutcome>()
        // Subscribed before posting, so a run that ends in the meantime cannot be missed.
        const unsubscribe = hub.subscribe(taskId, (event) => {
          if (event._tag === "run.updated" && event.run.id === runId && event.run.status !== "running") {
            Deferred.unsafeDone(answer, Effect.succeed<AskOutcome>({ _tag: "ended" }))
          }
        })
        return yield* Effect.gen(function* () {
          const attachments = yield* storeAttachments(input.attachments)
          const posted = yield* store.update(
            (s): Either.Either<{ task: Task; message: Message }, NotFound | Conflict> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              const run = s.runs.find((r) => r.id === runId)
              if (!run || run.taskId !== taskId || run.status !== "running") {
                return Either.left(new Conflict({ message: `run ${runId} is not the running run of task ${taskId}` }))
              }
              // A question is replaced only when its call has gone (the call was dropped); a waiting one blocks.
              const pending = s.pendingAsks.find((a) => a.taskId === taskId)
              if (pending && (pending.runId !== runId || liveAsks.has(runId))) {
                return Either.left(new Conflict({ message: "a question is already waiting for an answer" }))
              }
              const task = found.right
              const now = nowIso()
              const message: Message = {
                id: newId(),
                taskId,
                role: "agent",
                text: input.question.trim(),
                runId,
                createdAt: now,
                options: [...input.options],
                attachments,
              }
              s.messages.push(message)
              s.pendingAsks = [
                ...s.pendingAsks.filter((a) => a.taskId !== taskId),
                { taskId, runId, messageId: message.id },
              ]
              task.status = "needs_input"
              task.updatedAt = now
              liveAsks.set(runId, answer)
              return Either.right({ task: { ...task }, message })
            },
          )
          hub.publish({ _tag: "task.updated", task: posted.task })
          publishMessage(posted.message)
          const outcome = yield* Deferred.await(answer)
          if (outcome._tag === "answered") return outcome.text
          return yield* Effect.fail(new AskError({ message: "the run ended before the user answered" }))
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              unsubscribe()
              if (liveAsks.get(runId) === answer) liveAsks.delete(runId)
            }),
          ),
        )
      })

    const inbox: CoreShape["inbox"] = (taskId, runId) =>
      Effect.map(store.read, (state) => {
        // Read state of runs that have ended is no longer needed.
        for (const id of seenByRun.keys()) {
          if (state.runs.find((r) => r.id === id)?.status !== "running") seenByRun.delete(id)
        }
        const seen = seenFor(runId)
        const unread = state.messages.filter(
          (m) => m.taskId === taskId && m.role === "user" && m.runId === runId && !seen.has(m.id),
        )
        for (const m of unread) seen.add(m.id)
        return unread.map((m) => deliveredText(taskId, m))
      })

    const attachment: CoreShape["attachment"] = (user, taskId, attachmentId) =>
      Effect.gen(function* () {
        yield* ownedTask(user, taskId)
        const state = yield* store.read
        const stored = state.messages
          .filter((m) => m.taskId === taskId)
          .flatMap((m) => m.attachments ?? [])
          .find((a) => a.id === attachmentId)
        if (!stored) return yield* Effect.fail(new NotFound({ message: `attachment ${attachmentId} not found` }))
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(join(config.attachmentsDir, stored.id)),
          catch: (e) => new InternalError({ message: `read attachment: ${String(e)}` }),
        })
        return { mimeType: stored.mimeType, bytes }
      })

    /** Stores a file for one of the task's messages. Its bytes wait under the attachments dir until a message names it. */
    const upload: CoreShape["upload"] = (user, taskId, input) =>
      Effect.gen(function* () {
        yield* ownedTask(user, taskId)
        if (input.bytes.byteLength === 0) return yield* Effect.fail(new BadRequest({ message: "upload is empty" }))
        if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return yield* Effect.fail(
            new BadRequest({ message: `upload is ${input.bytes.byteLength} bytes; the limit is ${MAX_ATTACHMENT_BYTES}` }),
          )
        }
        const id = newId()
        const name = sanitizeUploadName(input.name)
        // The upload's bytes count against the thread now, not at the next storage check, so a burst of uploads between
        // checks cannot pass the limit. Refused like a full disk: the bytes that would cross it are not written.
        const before = storageUsed.get(taskId) ?? 0
        if (before + input.bytes.byteLength > config.taskDiskMax) {
          return yield* Effect.fail(
            new Conflict({
              message: `this upload would put the thread over its storage limit (${formatBytes(before)} of ${formatBytes(config.taskDiskMax)} used); delete files first`,
            }),
          )
        }
        const reserve = (bytes: number) => {
          storageUsed.set(taskId, (storageUsed.get(taskId) ?? 0) + bytes)
          const during = uploadedDuringCheck.get(taskId)
          if (during !== undefined) uploadedDuringCheck.set(taskId, during + bytes)
        }
        reserve(input.bytes.byteLength)
        const release = Effect.sync(() => reserve(-input.bytes.byteLength))
        yield* Effect.tryPromise({
          try: () => writeFile(join(config.attachmentsDir, id), input.bytes),
          catch: (e) => new InternalError({ message: `store upload: ${String(e)}` }),
        }).pipe(Effect.tapError(() => release))
        yield* store
          .update((s): Either.Either<void, NotFound | Conflict> => {
            const found = findTask(s, taskId)
            if (Either.isLeft(found)) return Either.left(found.left)
            if (found.right.archivedAt !== undefined) {
              return Either.left(new Conflict({ message: "task is archived; unarchive it first" }))
            }
            s.uploads.push({ id, taskId, mimeType: input.mimeType, name, createdAt: nowIso() })
            return Either.right(undefined)
          })
          .pipe(
            Effect.tapError(() =>
              Effect.tryPromise(() => rm(join(config.attachmentsDir, id), { force: true })).pipe(
                Effect.ignore,
                Effect.zipRight(release),
              ),
            ),
          )
        return { id, mimeType: input.mimeType, name }
      })

    // First check at startup, then every STORAGE_CHECK_MS; a failed check is logged and the next one runs anyway.
    yield* Effect.forkDaemon(
      checkStorage.pipe(
        Effect.catchAllCause((cause) => Effect.logWarning(`storage check failed: ${Cause.pretty(cause)}`)),
        Effect.repeat(Schedule.spaced(STORAGE_CHECK_MS)),
      ),
    )

    const shape: CoreShape = {
      ask,
      inbox,
      attachment,
      upload,
      health: () => Effect.void,

      listTasks: (user) =>
        Effect.map(store.read, (state) =>
          state.tasks
            .filter((t) => t.owner === user)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((t) => ({ ...t })),
        ),

      createTask,

      getTask: ownedTask,

      commands: (user, taskId, model) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          const state = yield* store.read
          // A running run owns the next message, and therefore the harness and its commands. Its own provider is
          // stored when the run starts, so a provider switch is right before the first session event arrives.
          const running = state.runs.find((r) => r.taskId === taskId && r.status === "running")
          const session = running === undefined ? undefined : state.runSessions.find((s) => s.runId === running.id)
          const provider = commandProvider(running, session, model)
          const cliProvider: CliProvider = provider === "anthropic" ? "claude-cli" : "codex-cli"
          const commands = yield* cliAuth.discoverCommands(user, cliProvider, threadDirOf(task.id))
          return { provider, commands }
        }),

      deleteTask: (user, id) => Effect.zipRight(ownedTask(user, id), deleteTask(id)),
      archiveTask,
      unarchiveTask,

      diff: (user, taskId) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          const checkouts = yield* Effect.forEach(task.checkouts, (checkout) =>
            workspace
              .diff({ ...checkoutSpec(task.id, checkout), baseRef: checkoutPinRef(task.id, checkout.id) })
              .pipe(
                Effect.map((diff) => ({
                  checkoutId: checkout.id,
                  repo: checkout.repo,
                  dir: checkout.dir,
                  baseBranch: checkout.baseBranch,
                  diff,
                })),
                Effect.mapError(toInternal("diff")),
              ),
          )
          return { checkouts }
        }),

      listMessages: (user, taskId) =>
        Effect.gen(function* () {
          yield* ownedTask(user, taskId)
          const state = yield* store.read
          return state.messages.filter((m) => m.taskId === taskId).map((m) => ({ ...m }))
        }),

      sendMessage,
      sendToThread,

      listRuns: (user, taskId) =>
        Effect.gen(function* () {
          yield* ownedTask(user, taskId)
          const state = yield* store.read
          return state.runs.filter((r) => r.taskId === taskId).map((r) => ({ ...r }))
        }),

      usage: (user, now) =>
        Effect.map(store.read, (state) => {
          const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
          const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
          const owned = new Set(state.tasks.filter((t) => t.owner === user).map((t) => t.id))
          const threads = new Set<string>()
          let agentMs = 0
          let runs = 0
          for (const run of state.runs) {
            if (!owned.has(run.taskId)) continue
            const from = Math.max(Date.parse(run.startedAt), start)
            const to = Math.min(run.endedAt === null ? now.getTime() : Date.parse(run.endedAt), end)
            if (to <= from) continue
            agentMs += to - from
            runs += 1
            threads.add(run.taskId)
          }
          return {
            periodStart: new Date(start).toISOString(),
            periodEnd: new Date(end).toISOString(),
            agentSeconds: Math.round(agentMs / 1000),
            runs,
            threads: threads.size,
          }
        }),

      cancelRun: (user, runId) =>
        Effect.gen(function* () {
          const run = yield* requireRun(runId)
          const state = yield* store.read
          if (!ownsTask(state, user, run.taskId)) {
            return yield* Effect.fail(new NotFound({ message: `run ${runId} not found` }))
          }
          if (run.status !== "running") {
            return yield* Effect.fail(new Conflict({ message: `run ${runId} is ${run.status}` }))
          }
          yield* harness.cancel(runId)
          return yield* requireRun(runId)
        }),

      runItems: (user, runId) =>
        Effect.gen(function* () {
          const run = yield* requireRun(runId)
          const state = yield* store.read
          if (!ownsTask(state, user, run.taskId)) {
            return yield* Effect.fail(new NotFound({ message: `run ${runId} not found` }))
          }
          return yield* harness.items(runId)
        }),

      desktopStatus: (user, taskId) => Effect.zipRight(ownedTask(user, taskId), desktop.status(taskId)),
      previewSocket: (user, taskId, path, protocol) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          if (task.archivedAt !== undefined) {
            return yield* Effect.fail(new Conflict({ message: "task is archived; unarchive it first" }))
          }
          if (task.previewPort === undefined) {
            return yield* Effect.fail(new NotFound({ message: "the agent has not opened a preview for this thread" }))
          }
          return yield* openTaskPreviewSocket(sandboxSettings, taskId, {
            port: task.previewPort,
            path,
            protocol,
          })
        }),
      previewRequest: (user, taskId, request) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          if (task.archivedAt !== undefined) {
            return yield* Effect.fail(new Conflict({ message: "task is archived; unarchive it first" }))
          }
          if (task.previewPort === undefined) {
            return yield* Effect.fail(new NotFound({ message: "the agent has not opened a preview for this thread" }))
          }
          const previewToken = request.headers.get("x-kestrel-preview-token")
          if (previewToken === null) {
            return yield* Effect.fail(new NotFound({ message: "preview session is invalid" }))
          }
          const requestUrl = new URL(request.url)
          const prefix = Paths.taskPreview(taskId)
          const framePrefix = Paths.taskPreviewFrame(previewToken, taskId).slice(0, -1)
          if (!requestUrl.pathname.startsWith(prefix)) {
            return yield* Effect.fail(new NotFound({ message: "preview route not found" }))
          }
          const path = `${requestUrl.pathname.slice(prefix.length) || "/"}${requestUrl.search}`
          if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)) {
            return yield* Effect.fail(new BadRequest({ message: "unsupported preview request method" }))
          }
          const headers: Record<string, string> = {}
          request.headers.forEach((value, name) => {
            if (["accept", "accept-language", "content-type", "range"].includes(name)) {
              headers[name] = value
            }
          })
          headers["accept-encoding"] = "identity"
          const body = request.method === "GET" || request.method === "HEAD"
            ? undefined
            : new Uint8Array(yield* Effect.tryPromise({
                try: () => request.arrayBuffer(),
                catch: () => new BadRequest({ message: "cannot read preview request body" }),
              }))
          const upstream = yield* taskPreviewFetch(sandboxSettings, taskId, {
            port: task.previewPort,
            method: request.method,
            path,
            headers,
            body,
          })
          const responseHeaders = new Headers(upstream.headers)
          for (const name of ["set-cookie", "set-cookie2", "content-length", "content-encoding", "content-security-policy", "connection", "x-frame-options"]) {
            responseHeaders.delete(name)
          }
          const location = responseHeaders.get("location")
          if (location?.startsWith("/")) responseHeaders.set("location", `${framePrefix}${location}`)
          let responseBody = new Uint8Array(yield* Effect.tryPromise({
            try: () => upstream.arrayBuffer(),
            catch: () => new InternalError({ message: "cannot read preview response" }),
          }))
          const prefixPath = `${framePrefix}/`
          const contentType = responseHeaders.get("content-type") ?? ""
          if (contentType.includes("text/html")) {
            let html = new TextDecoder().decode(responseBody)
            html = html.replace(/((?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${prefixPath}`)
            html = /<head(?:\s[^>]*)?>/i.test(html)
              ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${PREVIEW_SELECTOR_SCRIPT}`)
              : `${PREVIEW_SELECTOR_SCRIPT}${html}`
            responseBody = new TextEncoder().encode(html)
            responseHeaders.set("content-security-policy", "sandbox allow-scripts allow-forms")
          } else if (/javascript|ecmascript|text\/css/.test(contentType)) {
            const text = new TextDecoder().decode(responseBody)
            const rewritten = text.replace(/(["'`])\/(?!\/)/g, `$1${prefixPath}`).replace(/url\(\s*\/(?!\/)/g, `url(${prefixPath}`)
            responseBody = new TextEncoder().encode(rewritten)
          }
          const noBody = request.method === "HEAD" || [204, 205, 304].includes(upstream.status)
          responseHeaders.delete("content-length")
          responseHeaders.set("referrer-policy", "strict-origin-when-cross-origin")
          responseHeaders.set("cache-control", "no-store")
          responseHeaders.set("access-control-allow-origin", "*")
          return new Response(noBody ? null : responseBody, { status: upstream.status, headers: responseHeaders })
        }),

      desktopStart: (user, taskId) =>
        Effect.gen(function* () {
          const task = yield* ownedTask(user, taskId)
          if (task.archivedAt !== undefined) {
            return yield* Effect.fail(new Conflict({ message: "task is archived; unarchive it first" }))
          }
          return yield* startDesktop(task).pipe(
            Effect.mapError((e: DesktopError) => new InternalError({ message: e.message })),
          )
        }),

      desktopStop: (user, taskId) => Effect.zipRight(ownedTask(user, taskId), desktop.stop(taskId)),

      desktopSetQuality: (user, taskId, quality) =>
        Effect.zipRight(
          ownedTask(user, taskId),
          desktop
            .setQuality(taskId, quality)
            .pipe(Effect.mapError((e: DesktopError) => new Conflict({ message: e.message }))),
        ),

      desktopOpen: (taskId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          // A tool call still in flight from a run that archiving cancelled must not bring the desktop back.
          if (task.archivedAt !== undefined) {
            return yield* Effect.fail(new Conflict({ message: "task is archived; unarchive it first" }))
          }
          return yield* startDesktop(task).pipe(
            Effect.mapError((e: DesktopError) => new InternalError({ message: e.message })),
          )
        }),
      previewOpen: (taskId, runId, port) =>
        Effect.gen(function* () {
          const updated = yield* store.update(
            (s): Either.Either<Task, NotFound | Conflict> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              const run = s.runs.find((r) => r.id === runId)
              if (!run || run.taskId !== taskId || run.status !== "running") {
                return Either.left(new Conflict({ message: `run ${runId} is not the running run of task ${taskId}` }))
              }
              if (found.right.archivedAt !== undefined) {
                return Either.left(new Conflict({ message: "task is archived; unarchive it first" }))
              }
              found.right.previewPort = port
              found.right.updatedAt = nowIso()
              return Either.right({ ...found.right })
            },
          )
          hub.publish({ _tag: "task.updated", task: updated })
          return updated
        }),

      report: (taskId, runId, input) =>
        Effect.gen(function* () {
          const attachments = yield* storeAttachments(input.attachments)
          const updated = yield* store.update(
            (s): Either.Either<{ task: Task; message: Message | null }, NotFound | Conflict> => {
              const found = findTask(s, taskId)
              if (Either.isLeft(found)) return Either.left(found.left)
              // Only the task's running run may report, so a stale caller cannot leave the task in `running`.
              const run = s.runs.find((r) => r.id === runId)
              if (!run || run.taskId !== taskId || run.status !== "running") {
                return Either.left(new Conflict({ message: `run ${runId} is not the running run of task ${taskId}` }))
              }
              const task = found.right
              const now = nowIso()
              task.status = input.status
              task.updatedAt = now
              const trimmed = input.message.trim()
              let message: Message | null = null
              if (trimmed !== "" || attachments.length > 0) {
                message = { id: newId(), taskId, role: "agent", text: trimmed, runId, createdAt: now, attachments }
                s.messages.push(message)
              }
              return Either.right({ task: { ...task }, message })
            },
          )
          hub.publish({ _tag: "task.updated", task: updated.task })
          if (updated.message) publishMessage(updated.message)
        }),

      runFor: (runId) => Effect.map(store.read, (s) => {
        const run = s.runs.find((r) => r.id === runId)
        return run ? { ...run } : null
      }),

      execInTask: (taskId, command, timeoutMs) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const desktopNow = yield* desktop.status(taskId)
          const launch = yield* launchFor(task, "exec", desktopNow.display, command).pipe(
            Effect.mapError(toInternal("exec")),
          )
          return yield* runProcess(launch.file, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            timeoutMs,
          }).pipe(Effect.mapError(toInternal("exec")))
        }),

      desktopLaunch: (taskId, command) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const desktopNow = yield* desktop.status(taskId)
          if (desktopNow.display === null) {
            return yield* Effect.fail(new InternalError({ message: `desktop for task ${taskId} is not running` }))
          }
          const launch = yield* launchFor(task, "desktop", desktopNow.display, command).pipe(
            Effect.mapError(toInternal("desktop launch")),
          )
          const app = yield* desktop.launch(taskId, command, launch).pipe(Effect.mapError(toInternal("desktop launch")))
          return app.id
        }),

      toolkitInstall: (taskId, name) =>
        Effect.gen(function* () {
          yield* requireTask(taskId)
          return yield* installToolkit(config.toolkitsFlake, join(config.homesDir, taskId), name)
        }),

      checkout: (taskId, input) => addCheckout(taskId, input),

      taskOwner: (taskId) => Effect.map(requireTask(taskId), (task) => task.owner),
      storageUsed: (taskId) => storageUsed.get(taskId) ?? null,

      gitPush: (taskId, checkoutId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const checkout = yield* pickCheckout(task, checkoutId)
          yield* pushCheckout(task, checkout)
          return checkout.branch
        }),

      openPullRequest: (taskId, input) =>
        Effect.gen(function* () {
          const title = input.title.trim()
          if (title === "") return yield* Effect.fail(new BadRequest({ message: "pull request title is required" }))
          const task = yield* requireTask(taskId)
          const checkout = yield* pickCheckout(task, input.checkoutId)
          const ref = yield* checkoutRepoRef(checkout)
          const { slug, token } = yield* githubAccess(task.owner, ref)
          yield* pushCheckout(task, checkout)
          const existing = yield* github.findOpenPullRequest(token, slug, checkout.branch).pipe(Effect.mapError(fromGitHub))
          const pullRequest =
            existing ??
            (yield* github
              .createPullRequest(token, slug, {
                title,
                body: input.body,
                head: checkout.branch,
                base: checkout.baseBranch,
                draft: input.draft,
              })
              .pipe(Effect.mapError(fromGitHub)))
          yield* recordPullRequest(taskId, checkout.id, { number: pullRequest.number, url: pullRequest.url }, existing === null)
          return { pullRequest, created: existing === null }
        }),

      pullRequestStatus: (taskId, checkoutId) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const checkout = yield* pickCheckout(task, checkoutId)
          const ref = yield* checkoutRepoRef(checkout)
          const { slug, token } = yield* githubAccess(task.owner, ref)
          let number = checkout.pullRequest?.number
          if (number === undefined) {
            const found = yield* github.findOpenPullRequest(token, slug, checkout.branch).pipe(Effect.mapError(fromGitHub))
            if (found === null) {
              return yield* Effect.fail(
                new NotFound({ message: `no open pull request for ${checkout.branch}; open one with github_pr_create` }),
              )
            }
            yield* recordPullRequest(taskId, checkout.id, { number: found.number, url: found.url }, false)
            number = found.number
          }
          return yield* github.getPullRequestStatus(token, slug, number).pipe(Effect.mapError(fromGitHub))
        }),

      reviewPullRequest: (taskId, input) =>
        Effect.gen(function* () {
          const task = yield* requireTask(taskId)
          const checkout = yield* pickCheckout(task, input.checkoutId)
          const ref = yield* checkoutRepoRef(checkout)
          const { slug, token } = yield* githubAccess(task.owner, ref)
          return yield* github
            .createReview(token, slug, input.number, { body: input.body, event: input.event, comments: input.comments })
            .pipe(Effect.mapError(fromGitHub))
        }),

      shutdown: () =>
        Effect.gen(function* () {
          yield* harness.stopAll()
          yield* desktop.stopAll()
          stopAllTaskNets()
        }),
    }
    return shape
  }),
)

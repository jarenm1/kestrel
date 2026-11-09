import { QueryClient, queryOptions } from "@tanstack/react-query"
import { Either, Schema } from "effect"
import type { AgentModel, BoxList, DesktopStatus, Message, ModelProvider, Run, RunItems, Task, ThreadPullRequestAction } from "@cloudagents/protocol"
import { applyDesktopStatus, type DesktopStatusValue } from "@cloudagents/protocol"
import { isDesktopStreamActive } from "@/desktop/status"
import { api, signedInUser } from "./client"
import { fetchSnapshot, fetchTaskSnapshot } from "./snapshot"

/** Box health poll; keeps activity indicators and box settings current. */
const BOX_POLL_MS = 10_000

/** Model discovery polls once an hour while a picker is mounted. */
const MODEL_POLL_MS = 60 * 60_000

export const queryClient = new QueryClient({
  defaultOptions: {
    // Box calls fail for reasons a retry would not fix (offline box, refused token); failures surface immediately.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

/** Single source of truth for cache keys, so events and mutations update the same entries the pages read. */
export const keys = {
  me: ["me"] as const,
  /** The public site's view of the session on the app host (null when signed out). */
  publicMe: ["public-me"] as const,
  /** Assets attached to the `desktop-latest` GitHub release, for the download page. */
  desktopRelease: ["desktop-release"] as const,
  /** The user's boxes and which one is active. */
  boxes: ["boxes"] as const,
  /** Own health of one of the user's boxes, by its URL. */
  boxHealth: (url: string) => ["box-health", url] as const,
  /** Status of the box the apps talk to. */
  box: ["box"] as const,
  /** Status of Kestrel's box, read whichever box is active (the new-thread box picker). */
  kestrelBox: ["kestrel-box"] as const,
  /** Kestrel's managed boxes, as operators see them (`Me.operator`). */
  fleetBoxes: ["fleet-boxes"] as const,
  fleetActivity: ["fleet-activity"] as const,
  /** The most common tool and agent failures across Kestrel's boxes, as operators see them. */
  fleetToolFailures: ["fleet-tool-failures"] as const,
  /** Nest hosts and their capacity, as operators see them. */
  nestHosts: ["nest-hosts"] as const,
  /** A pairing code's pending approval, read by the approval page. */
  pairing: (code: string) => ["pairing", code] as const,
  connections: ["connections"] as const,
  usage: ["usage"] as const,
  providerUsage: ["providerUsage"] as const,
  usageActivity: ["usageActivity"] as const,
  automations: ["automations"] as const,
  githubRepos: ["github-repos"] as const,
  githubRepo: (repo: string) => ["github-repo", repo] as const,
  githubBranches: (repo: string) => ["github-branches", repo] as const,
  /** CLI sign-ins on the box the apps talk to. */
  cliAuth: ["cli-auth"] as const,
  /** What the active box can run (`BoxCapabilities`): which harnesses it has. */
  capabilities: ["capabilities"] as const,
  /** Every active-box model catalog, for invalidating them after a credential change. */
  allModels: ["models"] as const,
  /** The active box's model catalog, keyed by its stable identity so another box's catalog cannot appear. */
  models: (boxKey: string) => ["models", boxKey] as const,
  /** The signed-in user's generated-text preferences, keyed by the box route they were read from. */
  textGenerationSettings: (boxKey: string) => ["text-generation-settings", boxKey] as const,
  /** The signed-in user's thread preferences, keyed by the box route they were read from. */
  threadSettings: (boxKey: string) => ["thread-settings", boxKey] as const,
  /** All of the user's threads. Named apart from `task(id)` so invalidating one never touches the other. */
  tasks: ["task-list"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
  /** The box a thread lives on: a user box id, or null for Kestrel's box. */
  taskBox: (taskId: string) => ["tasks", taskId, "box"] as const,
  messages: (taskId: string) => ["tasks", taskId, "messages"] as const,
  runs: (taskId: string) => ["tasks", taskId, "runs"] as const,
  runItems: (runId: string) => ["runs", runId, "items"] as const,
  /** Per thread, model, active run and its provider: another thread's or harness's commands never leak in. */
  commands: (
    taskId: string | undefined,
    model: AgentModel | undefined,
    activeRunId: string | undefined,
    activeRunProvider: ModelProvider | undefined,
  ) => ["tasks", taskId, "commands", model, activeRunId, activeRunProvider] as const,
  diff: (taskId: string) => ["tasks", taskId, "diff"] as const,
  /** The thread's pull request registry, each with GitHub's live view. */
  pullRequests: (taskId: string) => ["tasks", taskId, "pull-requests"] as const,
  /** Everything about one pull request of the thread, named by its repository and number. */
  pullRequest: (taskId: string, repo: string, number: number) =>
    ["tasks", taskId, "pull-requests", repo, number] as const,
  pullRequestDiff: (taskId: string, repo: string, number: number) =>
    ["tasks", taskId, "pull-requests", repo, number, "diff"] as const,
  /** Both listings of a thread's files (with and without hidden ones); invalidating this refetches either. */
  files: (taskId: string) => ["tasks", taskId, "files"] as const,
  desktop: (taskId: string) => ["tasks", taskId, "desktop"] as const,
  /** URL of a file a thread's box serves (a `Paths` path), read from the box the thread lives on. */
  taskFile: (taskId: string, path: string) => ["task-file", taskId, path] as const,
}

/**
 * Roots of the queries read from the active box: box status, usage and per-box settings. Threads are read from the box
 * each one lives on, so they are not here. These are reset when the active box changes, so no figure or preference of
 * the previous box stays on screen.
 */
const ACTIVE_BOX_ROOTS: Record<string, true> = {
  connections: true,
  usage: true,
  providerUsage: true,
  usageActivity: true,
  "cli-auth": true,
  capabilities: true,
  models: true,
  "text-generation-settings": true,
  "thread-settings": true,
  box: true,
}

type Keyed = { readonly id: string }

export function upsert<T extends Keyed>(list: readonly T[] | undefined, item: T): T[] {
  const current = list ?? []
  const index = current.findIndex((x) => x.id === item.id)
  if (index === -1) return [...current, item]
  const next = [...current]
  next[index] = item
  return next
}

/**
 * Writes a task into the cache: its own entry, and the thread list if that is loaded. A list that is not loaded
 * stays unloaded; its query fetches it, so no partial list is ever cached. Writes are monotonic in `updatedAt`:
 * an event older than either cached copy (an out-of-order frame after a reconnect) is ignored; equal timestamps land.
 */
export function storeTask(client: QueryClient, task: Task): void {
  const cached = client.getQueryData<Task>(keys.task(task.id))
  const listed = client.getQueryData<readonly Task[]>(keys.tasks)?.find((candidate) => candidate.id === task.id)
  const newest =
    cached === undefined || (listed !== undefined && listed.updatedAt > cached.updatedAt) ? listed : cached
  if (newest !== undefined && task.updatedAt < newest.updatedAt) return
  client.setQueryData(keys.task(task.id), task)
  client.setQueryData(keys.tasks, (list: readonly Task[] | undefined) => (list === undefined ? list : upsert(list, task)))
}

/**
 * Invalidates the cached run item lists on (re)connect. `keys.runItems(runId)` is `["runs", runId, "items"]`,
 * outside the `keys.task(taskId)` prefix, so a reconnect that only invalidates the task prefix never refetches the
 * items an `agent.item` event missed while disconnected.
 */
export function invalidateRunItems(client: QueryClient, runIds: readonly string[]): void {
  for (const runId of runIds) void client.invalidateQueries({ queryKey: keys.runItems(runId), exact: true })
}

/**
 * Applies a desktop REST snapshot. The cache is read only after the fetch resolves, so a status frame or mutation
 * that landed while the request was in flight is seen and the snapshot does not overwrite it.
 */
export async function applyDesktopSnapshot(
  client: QueryClient,
  taskId: string,
  fetch: () => Promise<DesktopStatus>,
): Promise<DesktopStatusValue> {
  const status = await fetch()
  return applyDesktopStatus(
    client.getQueryData<DesktopStatusValue>(keys.desktop(taskId)),
    status,
    "event",
    undefined,
    isDesktopStreamActive(taskId),
  )
}

/** Removes a deleted task from the cache: the thread list drops it and its own entry goes away. */
export function dropTask(client: QueryClient, taskId: string): void {
  client.setQueryData(keys.tasks, (list: readonly Task[] | undefined) => list?.filter((task) => task.id !== taskId))
  client.removeQueries({ queryKey: keys.task(taskId), exact: true })
}

/**
 * Stores a box list. When the active box changes, or Kestrel's managed box changes (its id or URL), the queries read
 * from the box that was replaced are cancelled and reset, so mounted views refetch from the new box and no usage
 * figure of the old box stays on screen; the old managed box's cached token is dropped. When the set of boxes changes
 * (one added, removed or moved) or the managed box changes, the thread list refetches so it reads that set.
 */
export async function applyBoxList(client: QueryClient, list: BoxList): Promise<void> {
  const previous = client.getQueryData<BoxList>(keys.boxes)
  const previousManaged = previous?.managedBox ?? null
  const managedChanged = previousManaged?.id !== list.managedBox?.id || previousManaged?.url !== list.managedBox?.url
  if (previous?.activeBoxId !== list.activeBoxId || managedChanged) {
    const activeScoped = {
      predicate: (query: { queryKey: readonly unknown[] }) => ACTIVE_BOX_ROOTS[String(query.queryKey[0])] === true,
    }
    await client.cancelQueries(activeScoped)
    client.resetQueries(activeScoped)
  }
  if (managedChanged && previousManaged !== null) api.forgetBox(previousManaged.id)
  const before = JSON.stringify(previous?.boxes.map((box) => [box.id, box.url]) ?? [])
  const after = JSON.stringify(list.boxes.map((box) => [box.id, box.url]))
  if (before !== after || managedChanged) void client.invalidateQueries({ queryKey: keys.tasks })
  client.setQueryData(keys.boxes, list)
}

/**
 * The active box a model catalog belongs to. `key` identifies the exact box and route (`managedBox` keeps its id and
 * URL in the key, so a resumed box cannot serve an old catalog); `boxId` pins the box call to the same box. Kestrel's
 * box is the managed box's id, or `null` for the legacy relay.
 */
export interface ModelBoxScope {
  readonly key: string
  readonly boxId: string | null
}

/** The active box's catalog scope from a box list; undefined until the list has loaded. */
export function modelBoxScope(list: BoxList | undefined): ModelBoxScope | undefined {
  if (list === undefined) return undefined
  const active = list.activeBoxId
  // Kestrel's box is the managed box, whose own id pins the read; null stays only for the legacy relay.
  const box =
    active === null || active === list.managedBox?.id
      ? list.managedBox
      : list.boxes.find((candidate) => candidate.id === active)
  return {
    key: JSON.stringify([active, box?.id ?? null, box?.url ?? null]),
    boxId: active ?? box?.id ?? null,
  }
}

export interface DesktopAsset {
  readonly name: string
  readonly url: string
  readonly size: number
}

export interface DesktopRelease {
  readonly assets: readonly DesktopAsset[]
}

const GithubAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
})
const GithubRelease = Schema.Struct({ assets: Schema.Array(GithubAsset) })
const DESKTOP_RELEASE_URL = "https://api.github.com/repos/jarenm1/kestrel/releases/tags/desktop-latest"

/** The `desktop-latest` release; an unpublished release is an empty list, not an error. */
const fetchDesktopRelease = async (): Promise<DesktopRelease> => {
  const response = await fetch(DESKTOP_RELEASE_URL, { headers: { accept: "application/vnd.github+json" } })
  if (response.status === 404) return { assets: [] }
  if (!response.ok) throw new Error(`GitHub release answered ${response.status}`)
  const decoded = Schema.decodeUnknownEither(GithubRelease)((await response.json()) as unknown)
  if (Either.isLeft(decoded)) throw new Error("GitHub release returned an unexpected shape")
  return {
    assets: decoded.right.assets.map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    })),
  }
}

/**
 * Sends one pull request action and adopts the thread the box answers with. The list, detail and diff are refetched
 * because the action changes what GitHub reports; the panel keeps reading the same cache entries.
 */
export async function actOnPullRequest(
  client: QueryClient,
  taskId: string,
  action: ThreadPullRequestAction,
): Promise<Task> {
  const task = await api.actOnThreadPullRequest(taskId, action)
  storeTask(client, task)
  await Promise.all([
    client.invalidateQueries({ queryKey: keys.pullRequests(taskId), exact: true }),
    client.invalidateQueries({ queryKey: keys.pullRequest(taskId, action.repo, action.number) }),
    client.invalidateQueries({ queryKey: keys.pullRequestDiff(taskId, action.repo, action.number) }),
  ])
  return task
}

export const queries = {
  me: () => queryOptions({ queryKey: keys.me, queryFn: api.me }),
  publicMe: () => queryOptions({ queryKey: keys.publicMe, queryFn: signedInUser, staleTime: Infinity }),
  desktopRelease: () =>
    queryOptions({
      queryKey: keys.desktopRelease,
      queryFn: fetchDesktopRelease,
      staleTime: 5 * 60_000,
    }),
  boxes: () => queryOptions({ queryKey: keys.boxes, queryFn: api.boxes }),
  fleetBoxes: () => queryOptions({ queryKey: keys.fleetBoxes, queryFn: api.fleetBoxes }),
  fleetActivity: () =>
    queryOptions({ queryKey: keys.fleetActivity, queryFn: api.fleetActivity, refetchInterval: BOX_POLL_MS }),
  fleetToolFailures: () => queryOptions({ queryKey: keys.fleetToolFailures, queryFn: api.fleetToolFailures }),
  nestHosts: () => queryOptions({ queryKey: keys.nestHosts, queryFn: api.nestHosts }),
  pairing: (code: string) => queryOptions({ queryKey: keys.pairing(code), queryFn: () => api.pendingPairing(code) }),
  boxHealth: (url: string) =>
    queryOptions({ queryKey: keys.boxHealth(url), queryFn: () => api.checkBox(url), refetchInterval: BOX_POLL_MS }),
  box: () => queryOptions({ queryKey: keys.box, queryFn: api.boxStatus, refetchInterval: BOX_POLL_MS }),
  kestrelBox: () =>
    queryOptions({ queryKey: keys.kestrelBox, queryFn: api.kestrelBoxStatus, refetchInterval: BOX_POLL_MS }),
  connections: () => queryOptions({ queryKey: keys.connections, queryFn: api.connections }),
  usage: () => queryOptions({ queryKey: keys.usage, queryFn: api.usage }),
  providerUsage: () => queryOptions({ queryKey: keys.providerUsage, queryFn: api.providerUsage }),
  usageActivity: () => queryOptions({ queryKey: keys.usageActivity, queryFn: api.usageActivity }),
  automations: () => queryOptions({ queryKey: keys.automations, queryFn: api.listAutomations }),
  githubRepos: () => queryOptions({ queryKey: keys.githubRepos, queryFn: api.githubRepos }),
  githubRepo: (repo: string) =>
    queryOptions({ queryKey: keys.githubRepo(repo), queryFn: () => api.githubRepo(repo) }),
  githubBranches: (repo: string) =>
    queryOptions({ queryKey: keys.githubBranches(repo), queryFn: () => api.githubBranches(repo) }),
  cliAuth: () => queryOptions({ queryKey: keys.cliAuth, queryFn: api.cliAuth }),
  capabilities: () => queryOptions({ queryKey: keys.capabilities, queryFn: api.capabilities }),
  /**
   * The active box's merged model catalog, keyed by the box it was read from. A missing scope is the box list still
   * loading. Polls hourly; connection changes invalidate `keys.allModels` so a new login appears without waiting.
   */
  models: (scope: ModelBoxScope | undefined) =>
    queryOptions({
      queryKey: keys.models(scope?.key ?? "unavailable"),
      queryFn: () => {
        if (scope === undefined) throw new Error("The active box is not loaded")
        return api.models(false, scope.boxId)
      },
      enabled: scope !== undefined,
      staleTime: MODEL_POLL_MS,
      refetchInterval: MODEL_POLL_MS,
      refetchIntervalInBackground: true,
    }),
  textGenerationSettings: (boxKey: string, boxId: string | null) =>
    queryOptions({ queryKey: keys.textGenerationSettings(boxKey), queryFn: () => api.textGenerationSettings(boxId) }),
  threadSettings: (boxKey: string, boxId: string | null) =>
    queryOptions({ queryKey: keys.threadSettings(boxKey), queryFn: () => api.threadSettings(boxId) }),
  tasks: () => queryOptions({ queryKey: keys.tasks, queryFn: api.listTasks }),
  task: (taskId: string) =>
    queryOptions({
      queryKey: keys.task(taskId),
      queryFn: () => fetchTaskSnapshot(queryClient, keys.task(taskId), () => api.getTask(taskId)),
    }),
  // A thread never moves to another box.
  taskBox: (taskId: string) =>
    queryOptions({ queryKey: keys.taskBox(taskId), queryFn: () => api.taskBox(taskId), staleTime: Infinity }),
  messages: (taskId: string) =>
    queryOptions({
      queryKey: keys.messages(taskId),
      queryFn: () => fetchSnapshot(queryClient, keys.messages(taskId), () => api.listMessages(taskId)),
    }),
  runs: (taskId: string) =>
    queryOptions({
      queryKey: keys.runs(taskId),
      queryFn: () => fetchSnapshot(queryClient, keys.runs(taskId), () => api.listRuns(taskId)),
    }),
  runItems: (taskId: string, runId: string) =>
    queryOptions({
      queryKey: keys.runItems(runId),
      queryFn: () => fetchSnapshot(queryClient, keys.runItems(runId), () => api.runItems(taskId, runId)),
    }),
  /**
   * Disabled until there is both a focused thread and a model whose harness can answer. `activeRunId` and
   * `activeRunProvider` are part of the cache key because the server answers from a running turn's harness; they
   * are not sent on the wire.
   */
  commands: (
    taskId: string | undefined,
    model: AgentModel | undefined,
    activeRunId: string | undefined,
    activeRunProvider: ModelProvider | undefined,
  ) =>
    queryOptions({
      queryKey: keys.commands(taskId, model, activeRunId, activeRunProvider),
      queryFn: () => {
        if (taskId === undefined || model === undefined) {
          throw new Error("Slash commands need a thread and a model")
        }
        return api.commands(taskId, model)
      },
      enabled: taskId !== undefined && model !== undefined,
    }),
  diff: (taskId: string) => queryOptions({ queryKey: keys.diff(taskId), queryFn: () => api.getDiff(taskId) }),
  /**
   * The thread's pull requests. The interval lives on this observer, so GitHub is polled only while the panel is on
   * screen (another sidebar tab or a collapsed sidebar stops it).
   */
  pullRequests: (taskId: string) =>
    queryOptions({
      queryKey: keys.pullRequests(taskId),
      queryFn: () => api.getThreadPullRequests(taskId),
      refetchInterval: 60_000,
    }),
  pullRequest: (taskId: string, repo: string, number: number) =>
    queryOptions({
      queryKey: keys.pullRequest(taskId, repo, number),
      queryFn: () => api.getThreadPullRequest(taskId, repo, number),
    }),
  pullRequestDiff: (taskId: string, repo: string, number: number) =>
    queryOptions({
      queryKey: keys.pullRequestDiff(taskId, repo, number),
      queryFn: () => api.getThreadPullRequestDiff(taskId, repo, number),
    }),
  files: (taskId: string, hidden: boolean) =>
    queryOptions({ queryKey: [...keys.files(taskId), hidden] as const, queryFn: () => api.getFiles(taskId, hidden) }),
  desktop: (taskId: string) =>
    queryOptions({
      queryKey: keys.desktop(taskId),
      queryFn: () => applyDesktopSnapshot(queryClient, taskId, () => api.getDesktop(taskId)),
    }),
  taskFileUrl: (taskId: string, path: string) =>
    queryOptions({ queryKey: keys.taskFile(taskId, path), queryFn: () => api.taskFileUrl(taskId, path) }),
}

import { QueryClient, queryOptions } from "@tanstack/react-query"
import { Either, Schema } from "effect"
import type { AgentModel, BoxList, Message, ModelProvider, Run, RunItems, Task } from "@cloudagents/protocol"
import { api, signedInUser } from "./client"
import { fetchSnapshot, fetchTaskSnapshot } from "./snapshot"

/** Agent box status poll; it feeds the offline banner. */
const BOX_POLL_MS = 10_000

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
  /** The most common tool and agent failures across Kestrel's boxes, as operators see them. */
  fleetToolFailures: ["fleet-tool-failures"] as const,
  /** A pairing code's pending approval, read by the approval page. */
  pairing: (code: string) => ["pairing", code] as const,
  connections: ["connections"] as const,
  usage: ["usage"] as const,
  providerUsage: ["providerUsage"] as const,
  usageActivity: ["usageActivity"] as const,
  automations: ["automations"] as const,
  githubRepos: ["github-repos"] as const,
  githubBranches: (repo: string) => ["github-branches", repo] as const,
  /** CLI sign-ins on the box the apps talk to. */
  cliAuth: ["cli-auth"] as const,
  /** What the active box can run (`BoxCapabilities`): which harnesses it has. */
  capabilities: ["capabilities"] as const,
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
  /** Both listings of a thread's files (with and without hidden ones); invalidating this refetches either. */
  files: (taskId: string) => ["tasks", taskId, "files"] as const,
  desktop: (taskId: string) => ["tasks", taskId, "desktop"] as const,
  /** URL of a file a thread's box serves (a `Paths` path), read from the box the thread lives on. */
  taskFile: (taskId: string, path: string) => ["task-file", taskId, path] as const,
}

/**
 * Roots of the queries read from the active box: box status and usage. Threads are read from the box each one lives
 * on, so they are not here. These are reset when the active box changes, so no figure of the previous box stays on
 * screen.
 */
const ACTIVE_BOX_ROOTS: Record<string, true> = {
  connections: true,
  usage: true,
  providerUsage: true,
  usageActivity: true,
  "cli-auth": true,
  capabilities: true,
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
 * stays unloaded; its query fetches it, so no partial list is ever cached.
 */
export function storeTask(client: QueryClient, task: Task): void {
  client.setQueryData(keys.task(task.id), task)
  client.setQueryData(keys.tasks, (list: readonly Task[] | undefined) => list && upsert(list, task))
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
  fleetToolFailures: () => queryOptions({ queryKey: keys.fleetToolFailures, queryFn: api.fleetToolFailures }),
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
  githubBranches: (repo: string) =>
    queryOptions({ queryKey: keys.githubBranches(repo), queryFn: () => api.githubBranches(repo) }),
  cliAuth: () => queryOptions({ queryKey: keys.cliAuth, queryFn: api.cliAuth }),
  capabilities: () => queryOptions({ queryKey: keys.capabilities, queryFn: api.capabilities }),
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
  files: (taskId: string, hidden: boolean) =>
    queryOptions({ queryKey: [...keys.files(taskId), hidden] as const, queryFn: () => api.getFiles(taskId, hidden) }),
  desktop: (taskId: string) =>
    queryOptions({ queryKey: keys.desktop(taskId), queryFn: () => api.getDesktop(taskId) }),
  taskFileUrl: (taskId: string, path: string) =>
    queryOptions({ queryKey: keys.taskFile(taskId, path), queryFn: () => api.taskFileUrl(taskId, path) }),
}

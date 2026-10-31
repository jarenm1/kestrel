import { QueryClient, queryOptions } from "@tanstack/react-query"
import type { AgentModel, BoxList, Message, ModelProvider, Run, RunItems, Task } from "@cloudagents/protocol"
import { api, signedInUser } from "./client"

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
  /** The user's boxes and which one is active. */
  boxes: ["boxes"] as const,
  /** Own health of one of the user's boxes, by its URL. */
  boxHealth: (url: string) => ["box-health", url] as const,
  /** Status of the box the apps talk to. */
  box: ["box"] as const,
  connections: ["connections"] as const,
  usage: ["usage"] as const,
  automations: ["automations"] as const,
  /** CLI sign-ins on the box the apps talk to. */
  cliAuth: ["cli-auth"] as const,
  /** All of the user's threads. Named apart from `task(id)` so invalidating one never touches the other. */
  tasks: ["task-list"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
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
  desktop: (taskId: string) => ["tasks", taskId, "desktop"] as const,
  /** Signed URL of an attachment on the box in use; keyed by box so a switch fetches it from the new box. */
  attachment: (taskId: string, attachmentId: string, boxId: string | null | undefined) =>
    ["attachment", taskId, attachmentId, boxId] as const,
}

/**
 * Roots of the queries that do not depend on the active box: the account, the box list and the health of each box,
 * the connections and automations (control plane). Every other root is read from the active box and is reset when
 * the active box changes.
 */
const BOX_INDEPENDENT: Record<string, true> = {
  me: true,
  "public-me": true,
  boxes: true,
  "box-health": true,
  connections: true,
  automations: true,
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

/** Snapshot entries first; entries already in the cache from live events (newer) override them. */
function mergeSnapshot<T extends Keyed>(snapshot: readonly T[], current: readonly T[] | undefined): T[] {
  const byId = new Map<string, T>()
  for (const item of snapshot) byId.set(item.id, item)
  for (const item of current ?? []) byId.set(item.id, item)
  return [...byId.values()]
}

/**
 * Writes a task into the cache: its own entry, and the thread list if that is loaded. A list that is not loaded
 * stays unloaded; its query fetches it, so no partial list is ever cached.
 */
export function storeTask(client: QueryClient, task: Task): void {
  client.setQueryData(keys.task(task.id), task)
  client.setQueryData(keys.tasks, (list: readonly Task[] | undefined) => list && upsert(list, task))
}

/**
 * Stores a box list and, when the active box changes, drops everything read from the previous box: box-scoped
 * queries are cancelled and reset, so mounted views refetch from the new box and no thread or usage figure of the
 * old box stays on screen.
 */
export async function applyBoxList(client: QueryClient, list: BoxList): Promise<void> {
  const previous = client.getQueryData<BoxList>(keys.boxes)?.activeBoxId
  if (previous !== list.activeBoxId) {
    const boxScoped = {
      predicate: (query: { queryKey: readonly unknown[] }) => BOX_INDEPENDENT[String(query.queryKey[0])] !== true,
    }
    await client.cancelQueries(boxScoped)
    client.resetQueries(boxScoped)
  }
  client.setQueryData(keys.boxes, list)
}

export const queries = {
  me: () => queryOptions({ queryKey: keys.me, queryFn: api.me }),
  publicMe: () => queryOptions({ queryKey: keys.publicMe, queryFn: signedInUser, staleTime: Infinity }),
  boxes: () => queryOptions({ queryKey: keys.boxes, queryFn: api.boxes }),
  boxHealth: (url: string) =>
    queryOptions({ queryKey: keys.boxHealth(url), queryFn: () => api.checkBox(url), refetchInterval: BOX_POLL_MS }),
  box: () => queryOptions({ queryKey: keys.box, queryFn: api.boxStatus, refetchInterval: BOX_POLL_MS }),
  connections: () => queryOptions({ queryKey: keys.connections, queryFn: api.connections }),
  usage: () => queryOptions({ queryKey: keys.usage, queryFn: api.usage }),
  automations: () => queryOptions({ queryKey: keys.automations, queryFn: api.listAutomations }),
  cliAuth: () => queryOptions({ queryKey: keys.cliAuth, queryFn: api.cliAuth }),
  tasks: () => queryOptions({ queryKey: keys.tasks, queryFn: api.listTasks }),
  task: (taskId: string) => queryOptions({ queryKey: keys.task(taskId), queryFn: () => api.getTask(taskId) }),
  messages: (taskId: string) =>
    queryOptions({
      queryKey: keys.messages(taskId),
      queryFn: async (): Promise<Message[]> =>
        mergeSnapshot(await api.listMessages(taskId), queryClient.getQueryData(keys.messages(taskId))),
    }),
  runs: (taskId: string) =>
    queryOptions({
      queryKey: keys.runs(taskId),
      queryFn: async (): Promise<Run[]> =>
        mergeSnapshot(await api.listRuns(taskId), queryClient.getQueryData(keys.runs(taskId))),
    }),
  runItems: (runId: string) =>
    queryOptions({
      queryKey: keys.runItems(runId),
      queryFn: async (): Promise<RunItems> =>
        mergeSnapshot(await api.runItems(runId), queryClient.getQueryData(keys.runItems(runId))),
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
  desktop: (taskId: string) =>
    queryOptions({ queryKey: keys.desktop(taskId), queryFn: () => api.getDesktop(taskId) }),
  attachmentUrl: (taskId: string, attachmentId: string, boxId: string | null | undefined) =>
    queryOptions({
      queryKey: keys.attachment(taskId, attachmentId, boxId),
      queryFn: () => api.attachmentUrl(taskId, attachmentId),
    }),
}

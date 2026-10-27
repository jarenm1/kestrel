import { QueryClient, queryOptions } from "@tanstack/react-query"
import type { Message, Run } from "@cloudagents/protocol"
import { api } from "./client"

/** Agent box status poll; it feeds the top bar pill and the offline banner. */
const BOX_POLL_MS = 10_000
/** Task statuses change from agent runs with no repo-level event stream, so the list is polled. */
const TASK_POLL_MS = 2000

export const queryClient = new QueryClient({
  defaultOptions: {
    // Every box call crosses the relay; failures surface immediately instead of being retried.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

/** Single source of truth for cache keys, so events and mutations update the same entries the pages read. */
export const keys = {
  me: ["me"] as const,
  box: ["box"] as const,
  connections: ["connections"] as const,
  githubRepos: ["github", "repos"] as const,
  repos: ["repos"] as const,
  repo: (repoId: string) => ["repos", repoId] as const,
  repoTasks: (repoId: string) => ["repos", repoId, "tasks"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
  messages: (taskId: string) => ["tasks", taskId, "messages"] as const,
  runs: (taskId: string) => ["tasks", taskId, "runs"] as const,
  diff: (taskId: string) => ["tasks", taskId, "diff"] as const,
  desktop: (taskId: string) => ["tasks", taskId, "desktop"] as const,
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

export const queries = {
  me: () => queryOptions({ queryKey: keys.me, queryFn: api.me }),
  box: () => queryOptions({ queryKey: keys.box, queryFn: api.box, refetchInterval: BOX_POLL_MS }),
  connections: () => queryOptions({ queryKey: keys.connections, queryFn: api.connections }),
  githubRepos: () => queryOptions({ queryKey: keys.githubRepos, queryFn: api.githubRepos }),
  repos: () => queryOptions({ queryKey: keys.repos, queryFn: api.listRepos }),
  repo: (repoId: string) => queryOptions({ queryKey: keys.repo(repoId), queryFn: () => api.getRepo(repoId) }),
  repoTasks: (repoId: string) =>
    queryOptions({
      queryKey: keys.repoTasks(repoId),
      queryFn: () => api.listRepoTasks(repoId),
      refetchInterval: TASK_POLL_MS,
    }),
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
  diff: (taskId: string) => queryOptions({ queryKey: keys.diff(taskId), queryFn: () => api.getDiff(taskId) }),
  desktop: (taskId: string) =>
    queryOptions({ queryKey: keys.desktop(taskId), queryFn: () => api.getDesktop(taskId) }),
}

import { QueryClient, queryOptions, type QueryKey } from "@tanstack/react-query";
import type { AgentItem, AgentModel, Message, ModelProvider, Run, Task } from "@cloudagents/protocol";
import type { ApiClient } from "@/api/client";

/**
 * A request about one thread. It names the box client that sent it, so the response is cached under that box even if
 * the active box has changed while the request was in flight.
 */
export interface ThreadCall {
  readonly api: ApiClient;
  readonly taskId: string;
}

/** Agent box status poll; it feeds the top bar pill. */
const BOX_POLL_MS = 10_000;
/** Task statuses change from agent runs with no list-level event stream, so the thread list is polled. */
const TASK_POLL_MS = 2000;
/** The diff has no change events; it is polled while the agent runs and refetched when a run updates. */
const DIFF_POLL_MS = 3000;

export const queryClient = new QueryClient({
  defaultOptions: {
    // Every box call crosses the relay; failures surface immediately instead of being retried.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

/** Single source of truth for cache keys, so events and mutations update the same entries the screens read. */
export const keys = {
  me: ["me"] as const,
  connections: ["connections"] as const,
  githubRepos: ["github-repos"] as const,
  githubBranches: (repo: string) => ["github-repos", repo, "branches"] as const,
  automations: ["automations"] as const,
  automationRuns: (automationId: string) => ["automations", automationId, "runs"] as const,
};

/** Box-served data is isolated by box identity even when task or run IDs coincide. */
export const boxKeys = (scope: string) => ({
  connections: [...keys.connections, scope] as const,
  box: ["box-data", scope, "status"] as const,
  usage: ["box-data", scope, "usage"] as const,
  providerUsage: ["box-data", scope, "provider-usage"] as const,
  /** What the box can run (`BoxCapabilities`): which harnesses it has. */
  capabilities: ["box-data", scope, "capabilities"] as const,
  usageActivity: ["box-data", scope, "usage-activity"] as const,
  /** All of the user's threads. Named apart from `task(id)` so invalidating one never touches the other. */
  tasks: ["box-data", scope, "task-list"] as const,
  task: (taskId: string) => ["box-data", scope, "tasks", taskId] as const,
  messages: (taskId: string) => ["box-data", scope, "tasks", taskId, "messages"] as const,
  runs: (taskId: string) => ["box-data", scope, "tasks", taskId, "runs"] as const,
  runItems: (runId: string) => ["box-data", scope, "runs", runId, "items"] as const,
  commands: (
    taskId: string | undefined,
    model: AgentModel | undefined,
    activeRunId: string | undefined,
    activeRunProvider: ModelProvider | undefined,
  ) => ["box-data", scope, "tasks", taskId, "commands", model, activeRunId, activeRunProvider] as const,
  diff: (taskId: string) => ["box-data", scope, "tasks", taskId, "diff"] as const,
  desktop: (taskId: string) => ["box-data", scope, "tasks", taskId, "desktop"] as const,
});

type Keyed = { readonly id: string };

export function upsert<T extends Keyed>(list: readonly T[] | undefined, item: T): T[] {
  const current = list ?? [];
  const index = current.findIndex((x) => x.id === item.id);
  if (index === -1) return [...current, item];
  const next = [...current];
  next[index] = item;
  return next;
}

/** Snapshot entries first; entries already in the cache from live events (newer) override them. */
function mergeSnapshot<T extends Keyed>(snapshot: readonly T[], current: readonly T[] | undefined): T[] {
  const byId = new Map<string, T>();
  for (const item of snapshot) byId.set(item.id, item);
  for (const item of current ?? []) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * Fetches one task, keeping the task live events wrote while the fetch was in flight: it is newer than the snapshot.
 * A task always has a cache entry from an earlier visit, so identity, not presence, is what says an event landed
 * during the fetch: a thread opened while its run reports context would otherwise show the snapshot read before it.
 */
export async function fetchTaskSnapshot(key: QueryKey, fetch: () => Promise<Task>): Promise<Task> {
  const before = queryClient.getQueryData<Task>(key);
  const task = await fetch();
  const current = queryClient.getQueryData<Task>(key);
  return current !== undefined && current !== before ? current : task;
}

/**
 * Writes a task into the cache: its own entry, and the thread list if that is loaded. A list that is not loaded
 * stays unloaded; its query fetches it, so no partial list is ever cached.
 */
export function storeTask(client: QueryClient, task: Task, scope: string): void {
  const scoped = boxKeys(scope);
  client.setQueryData(scoped.task(task.id), task);
  client.setQueryData(scoped.tasks, (list: readonly Task[] | undefined) => list && upsert(list, task));
}

export function createQueries(api: ApiClient) {
  const scoped = boxKeys(api.boxScope);
  return {
    me: () => queryOptions({ queryKey: keys.me, queryFn: () => api.me() }),
    box: () => queryOptions({ queryKey: scoped.box, queryFn: () => api.box(), refetchInterval: BOX_POLL_MS }),
    connections: () => queryOptions({ queryKey: scoped.connections, queryFn: () => api.connections() }),
    githubRepos: () => queryOptions({ queryKey: keys.githubRepos, queryFn: () => api.githubRepos() }),
    githubBranches: (repo: string) =>
      queryOptions({ queryKey: keys.githubBranches(repo), queryFn: () => api.githubBranches(repo) }),
    automations: () => queryOptions({ queryKey: keys.automations, queryFn: () => api.listAutomations() }),
    automationRuns: (automationId: string) =>
      queryOptions({
        queryKey: keys.automationRuns(automationId),
        queryFn: () => api.listAutomationRuns(automationId),
      }),
    tasks: () => queryOptions({ queryKey: scoped.tasks, queryFn: () => api.listTasks(), refetchInterval: TASK_POLL_MS }),
    task: (taskId: string) =>
      queryOptions({
        queryKey: scoped.task(taskId),
        queryFn: () => fetchTaskSnapshot(scoped.task(taskId), () => api.getTask(taskId)),
      }),
    messages: (taskId: string) =>
      queryOptions({
        queryKey: scoped.messages(taskId),
        queryFn: async (): Promise<Message[]> =>
          mergeSnapshot(await api.listMessages(taskId), queryClient.getQueryData(scoped.messages(taskId))),
      }),
    runs: (taskId: string) =>
      queryOptions({
        queryKey: scoped.runs(taskId),
        queryFn: async (): Promise<Run[]> =>
          mergeSnapshot(await api.listRuns(taskId), queryClient.getQueryData(scoped.runs(taskId))),
      }),
    runItems: (runId: string) =>
      queryOptions({
        queryKey: scoped.runItems(runId),
        queryFn: async (): Promise<AgentItem[]> =>
          mergeSnapshot(await api.runItems(runId), queryClient.getQueryData(scoped.runItems(runId))),
      }),
    diff: (taskId: string, running = false) =>
      queryOptions({
        queryKey: scoped.diff(taskId),
        queryFn: () => api.getDiff(taskId),
        refetchInterval: running ? DIFF_POLL_MS : false,
      }),
    desktop: (taskId: string) =>
      queryOptions({ queryKey: scoped.desktop(taskId), queryFn: () => api.getDesktop(taskId) }),
    usage: () => queryOptions({ queryKey: scoped.usage, queryFn: () => api.usage() }),
    providerUsage: () => queryOptions({ queryKey: scoped.providerUsage, queryFn: () => api.providerUsage() }),
    capabilities: () => queryOptions({ queryKey: scoped.capabilities, queryFn: () => api.capabilities() }),
    usageActivity: () => queryOptions({ queryKey: scoped.usageActivity, queryFn: () => api.usageActivity() }),
    commands: (
      taskId: string | undefined,
      model: AgentModel | undefined,
      activeRunId: string | undefined,
      activeRunProvider: ModelProvider | undefined,
    ) =>
      queryOptions({
        queryKey: scoped.commands(taskId, model, activeRunId, activeRunProvider),
        queryFn: () => {
          if (taskId === undefined || model === undefined) {
            throw new Error("Slash commands need a thread and a model");
          }
          return api.commands(taskId, model);
        },
        enabled: taskId !== undefined && model !== undefined,
      }),
  };
}

import { QueryClient, queryOptions, type QueryKey } from "@tanstack/react-query";
import {
  mergeSnapshot as mergeLiveSnapshot,
  type AgentItem,
  type AgentModel,
  type Message,
  type ModelProvider,
  type Run,
  type Task,
} from "@cloudagents/protocol";
import type { ApiClient } from "@/api/client";
import { applyDesktopStatus, type DesktopStatusValue } from "@cloudagents/protocol";
import { pendingSaves } from "@/lib/pendingSaves";

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
/** Runtime model catalogs change rarely; a mounted picker re-reads one hourly. */
const MODEL_CATALOG_POLL_MS = 60 * 60 * 1000;

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
  /** The box's runtime model catalog (`ModelCatalog`), resolved for its owner's credentials. */
  models: ["box-data", scope, "models"] as const,
  /** Generated-text preferences of this box's user (title, model, streaming). */
  textGenerationSettings: ["box-data", scope, "text-generation-settings"] as const,
  /** Thread-run preferences of this box's user (usage-limit auto-resume). */
  threadSettings: ["box-data", scope, "thread-settings"] as const,
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

/**
 * Fresh snapshots replace stale cache entries; only events written during the fetch override them. The merge itself
 * is `mergeSnapshot` from `@cloudagents/protocol`, shared with the web client so the two cannot drift apart, including
 * the rule that an id removed from the cache during the fetch is not resurrected.
 */
async function fetchMergedSnapshot<T extends Keyed>(key: QueryKey, fetch: () => Promise<readonly T[]>): Promise<T[]> {
  const before = queryClient.getQueryData<readonly T[]>(key) ?? [];
  const snapshot = await fetch();
  const cached = queryClient.getQueryData<readonly T[]>(key) ?? [];
  return mergeLiveSnapshot(snapshot, cached, new Set(before));
}

/**
 * Fetches one task, keeping the task live events wrote while the fetch was in flight: it is newer than the snapshot.
 * A task always has a cache entry from an earlier visit, so identity, not presence, is what says an event landed
 * during the fetch: a thread opened while its run reports context would otherwise show the snapshot read before it.
 * A snapshot older than an event that landed before the fetch started is ignored the same way; equal timestamps are
 * the same write.
 */
export async function fetchTaskSnapshot(key: QueryKey, fetch: () => Promise<Task>): Promise<Task> {
  const before = queryClient.getQueryData<Task>(key);
  const task = await fetch();
  const current = queryClient.getQueryData<Task>(key);
  if (current !== undefined && current !== before) return current;
  if (current !== undefined && task.updatedAt < current.updatedAt) return current;
  return task;
}

/**
 * Writes a task into the cache: its own entry, and the thread list if that is loaded. A list that is not loaded
 * stays unloaded; its query fetches it, so no partial list is ever cached. Writes are monotonic in `updatedAt`: an
 * event older than either cached copy (an out-of-order frame after a reconnect) is ignored; equal timestamps land.
 */
export function storeTask(client: QueryClient, task: Task, scope: string): void {
  const scoped = boxKeys(scope);
  const cached = client.getQueryData<Task>(scoped.task(task.id));
  const listed = client
    .getQueryData<readonly Task[]>(scoped.tasks)
    ?.find((candidate) => candidate.id === task.id);
  const newest =
    cached === undefined || (listed !== undefined && listed.updatedAt > cached.updatedAt) ? listed : cached;
  if (newest !== undefined && task.updatedAt < newest.updatedAt) return;
  client.setQueryData(scoped.task(task.id), task);
  client.setQueryData(scoped.tasks, (list: readonly Task[] | undefined) =>
    list === undefined ? list : upsert(list, task)
  );
}

/**
 * Invalidates the cached run item lists on (re)connect. `runItems(runId)` lives outside the task prefix, so a
 * reconnect that only invalidates the task never refetches the items an `agent.item` event missed while disconnected.
 */
export function invalidateRunItems(client: QueryClient, runIds: readonly string[], scope: string): void {
  const scoped = boxKeys(scope);
  for (const runId of runIds) {
    void client.invalidateQueries({ queryKey: scoped.runItems(runId), exact: true });
  }
}

export function createQueries(api: ApiClient) {
  const scoped = boxKeys(api.boxScope);

  /**
   * Settings reads wait for a form that just closed on this box: its PUT must land first, or the GET can return the
   * pre-save value after the save already updated the cache, and a reopened form would then hydrate stale settings.
   */
  const afterPendingSettings = async () => {
    const pending = pendingSaves(api.boxScope);
    if (pending !== undefined) await pending;
  };
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
    tasks: () =>
      queryOptions({
        queryKey: scoped.tasks,
        queryFn: () => fetchMergedSnapshot(scoped.tasks, () => api.listTasks()),
        refetchInterval: TASK_POLL_MS,
      }),
    task: (taskId: string) =>
      queryOptions({
        queryKey: scoped.task(taskId),
        queryFn: () => fetchTaskSnapshot(scoped.task(taskId), () => api.getTask(taskId)),
      }),
    messages: (taskId: string) =>
      queryOptions({
        queryKey: scoped.messages(taskId),
        queryFn: () => fetchMergedSnapshot(scoped.messages(taskId), () => api.listMessages(taskId)),
      }),
    runs: (taskId: string) =>
      queryOptions({
        queryKey: scoped.runs(taskId),
        queryFn: () => fetchMergedSnapshot(scoped.runs(taskId), () => api.listRuns(taskId)),
      }),
    runItems: (runId: string) =>
      queryOptions({
        queryKey: scoped.runItems(runId),
        queryFn: () => fetchMergedSnapshot(scoped.runItems(runId), () => api.runItems(runId)),
      }),
    diff: (taskId: string, running = false) =>
      queryOptions({
        queryKey: scoped.diff(taskId),
        queryFn: () => api.getDiff(taskId),
        refetchInterval: running ? DIFF_POLL_MS : false,
      }),
    desktop: (taskId: string) =>
      queryOptions({
        queryKey: scoped.desktop(taskId),
        queryFn: async (): Promise<DesktopStatusValue> =>
          applyDesktopStatus(
            queryClient.getQueryData<DesktopStatusValue>(scoped.desktop(taskId)),
            await api.getDesktop(taskId),
            "event"
          ),
      }),
    usage: () => queryOptions({ queryKey: scoped.usage, queryFn: () => api.usage() }),
    providerUsage: () => queryOptions({ queryKey: scoped.providerUsage, queryFn: () => api.providerUsage() }),
    capabilities: () => queryOptions({ queryKey: scoped.capabilities, queryFn: () => api.capabilities() }),
    models: () =>
      queryOptions({
        queryKey: scoped.models,
        queryFn: () => api.models(),
        staleTime: MODEL_CATALOG_POLL_MS,
        refetchInterval: MODEL_CATALOG_POLL_MS,
      }),
    textGenerationSettings: () =>
      queryOptions({
        queryKey: scoped.textGenerationSettings,
        queryFn: async () => {
          await afterPendingSettings();
          return api.textGenerationSettings();
        },
      }),
    threadSettings: () =>
      queryOptions({
        queryKey: scoped.threadSettings,
        queryFn: async () => {
          await afterPendingSettings();
          return api.threadSettings();
        },
      }),
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

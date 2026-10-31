import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { AgentItem, AgentModel, Message, ModelProvider, Run, Task } from "@cloudagents/protocol";
import type { ApiClient } from "@/api/client";

/** Agent box status poll; it feeds the top bar pill. */
const BOX_POLL_MS = 10_000;
/** The diff has no change events; it is polled while the agent runs and refetched when a run updates. */
const DIFF_POLL_MS = 3000;

export const queryClient = new QueryClient({
  defaultOptions: {
    // Box calls go straight to their box; failures surface immediately instead of being retried.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

/** Single source of truth for cache keys, so events and mutations update the same entries the screens read. */
export const keys = {
  me: ["me"] as const,
  box: ["box"] as const,
  connections: ["connections"] as const,
  usage: ["usage"] as const,
  githubRepos: ["github-repos"] as const,
  automations: ["automations"] as const,
  automationRuns: (automationId: string) => ["automations", automationId, "runs"] as const,
  /** All of the user's threads. Named apart from `task(id)` so invalidating one never touches the other. */
  tasks: ["task-list"] as const,
  task: (taskId: string) => ["tasks", taskId] as const,
  messages: (taskId: string) => ["tasks", taskId, "messages"] as const,
  runs: (taskId: string) => ["tasks", taskId, "runs"] as const,
  runItems: (runId: string) => ["runs", runId, "items"] as const,
  commands: (
    taskId: string | undefined,
    model: AgentModel | undefined,
    activeRunId: string | undefined,
    activeRunProvider: ModelProvider | undefined,
  ) => ["tasks", taskId, "commands", model, activeRunId, activeRunProvider] as const,
  diff: (taskId: string) => ["tasks", taskId, "diff"] as const,
  desktop: (taskId: string) => ["tasks", taskId, "desktop"] as const,
};

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
 * Writes a task into the cache: its own entry, and the thread list if that is loaded. A list that is not loaded
 * stays unloaded; its query fetches it, so no partial list is ever cached.
 */
export function storeTask(client: QueryClient, task: Task): void {
  client.setQueryData(keys.task(task.id), task);
  client.setQueryData(keys.tasks, (list: readonly Task[] | undefined) => list && upsert(list, task));
}

/** Roots of the box-served cache entries. Switching the active box drops them: they describe the box that was active. */
const BOX_SCOPED_ROOTS: readonly unknown[] = [keys.box[0], keys.usage[0], keys.tasks[0], keys.task("")[0], keys.runItems("")[0]];

/** Drops every cached box-served entry; control-plane entries (me, connections, automations, repos) stay. */
export function clearBoxScopedQueries(client: QueryClient): void {
  client.removeQueries({ predicate: (query) => BOX_SCOPED_ROOTS.includes(query.queryKey[0]) });
}

export function createQueries(api: ApiClient) {
  return {
    me: () => queryOptions({ queryKey: keys.me, queryFn: () => api.me() }),
    box: () => queryOptions({ queryKey: keys.box, queryFn: () => api.box(), refetchInterval: BOX_POLL_MS }),
    connections: () => queryOptions({ queryKey: keys.connections, queryFn: () => api.connections() }),
    githubRepos: () => queryOptions({ queryKey: keys.githubRepos, queryFn: () => api.githubRepos() }),
    automations: () => queryOptions({ queryKey: keys.automations, queryFn: () => api.listAutomations() }),
    automationRuns: (automationId: string) =>
      queryOptions({
        queryKey: keys.automationRuns(automationId),
        queryFn: () => api.listAutomationRuns(automationId),
      }),
    tasks: () => queryOptions({ queryKey: keys.tasks, queryFn: () => api.listTasks() }),
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
        queryFn: async (): Promise<AgentItem[]> =>
          mergeSnapshot(await api.runItems(runId), queryClient.getQueryData(keys.runItems(runId))),
      }),
    diff: (taskId: string, running = false) =>
      queryOptions({
        queryKey: keys.diff(taskId),
        queryFn: () => api.getDiff(taskId),
        refetchInterval: running ? DIFF_POLL_MS : false,
      }),
    desktop: (taskId: string) =>
      queryOptions({ queryKey: keys.desktop(taskId), queryFn: () => api.getDesktop(taskId) }),
    usage: () => queryOptions({ queryKey: keys.usage, queryFn: () => api.usage() }),
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
            throw new Error("Slash commands need a thread and a model");
          }
          return api.commands(taskId, model);
        },
        enabled: taskId !== undefined && model !== undefined,
      }),
  };
}

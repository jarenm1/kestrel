import { useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { Paths, mergeRunUpdate, type AgentItem, type Message, type Run } from "@cloudagents/protocol";
import { openTaskEvents } from "@/api/events";
import { createQueries, boxKeys, invalidateRunItems, storeTask, upsert } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";
import { threadErrors } from "@/hooks/threadErrors";
import { applyDesktopStatus, type DesktopStatusValue } from "@cloudagents/protocol";

const MAX_LOG_LINES = 2000;
const RECONNECT_MS = 2000;

/**
 * Applies a live run update to the cached list at `key`. The event's run comes from the state store, which never
 * holds saved evidence (clips live on disk), so the cached clips stay until a new snapshot carries them.
 */
export function storeRunUpdate(client: QueryClient, key: QueryKey, run: Run): void {
  client.setQueryData(key, (list: Run[] | undefined) =>
    upsert(list, mergeRunUpdate(list?.find((cached) => cached.id === run.id), run))
  );
}

/**
 * Task chat state: REST snapshots in the query cache, kept current by the task events WebSocket.
 * Each (re)connect re-snapshots; live events are written straight into the same cache entries.
 */
export function useTaskState(taskId: string) {
  const { api } = useApiClient();
  const keys = boxKeys(api.boxScope);
  const queryClient = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);

  // The desktop query is the baseline for desktop.updated transitions; keeping it live keeps that cache entry current.
  const [task, messages, runs, desktop] = useQueries({
    queries: [
      queries.task(taskId),
      queries.messages(taskId),
      queries.runs(taskId),
      queries.desktop(taskId),
    ],
  });
  const [output, setOutput] = useState<Record<string, string[]>>({});
  const [disconnected, setDisconnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [desktopOpens, setDesktopOpens] = useState(0);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let close: (() => void) | undefined;

    const reconnect = () => {
      if (!active) return;
      setDisconnected(true);
      retry = setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS);
    };

    // A box token that cannot be minted, or a socket that cannot be opened, reconnects like a dropped socket.
    const open = async () => {
      const url = await api.socketUrl(Paths.taskEventsWs(taskId));
      if (!active) return;
      close = openTaskEvents(url, {
        onOpen: () => {
          setDisconnected(false);
          // Prefix invalidation refreshes task, messages and runs, including events missed while disconnected.
          void queryClient.invalidateQueries({ queryKey: keys.task(taskId) });
          // Run items live under the run, outside the task prefix, so a reconnect refetches each cached run's items.
          const cachedRuns = queryClient.getQueryData<readonly Run[]>(keys.runs(taskId)) ?? [];
          invalidateRunItems(
            queryClient,
            cachedRuns.map((run) => run.id),
            api.boxScope
          );
        },
        onEvent: (event) => {
          switch (event._tag) {
            case "task.updated":
              storeTask(queryClient, event.task, api.boxScope);
              break;
            case "message.created":
              queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) =>
                upsert(list, event.message)
              );
              break;
            case "run.updated":
              storeRunUpdate(queryClient, keys.runs(taskId), event.run);
              // A run starting or ending is when the worktree changes; the diff has no events of its own.
              void queryClient.invalidateQueries({ queryKey: keys.diff(taskId) });
              break;
            case "agent.output":
              setOutput((prev) => ({
                ...prev,
                [event.runId]: [...(prev[event.runId] ?? []), ...event.text.split("\n")].slice(-MAX_LOG_LINES),
              }));
              break;
            case "agent.item":
              // Same id means the item was replaced (a tool finishing), so upsert keeps its place.
              queryClient.setQueryData(keys.runItems(event.runId), (list: AgentItem[] | undefined) =>
                upsert(list, event.item)
              );
              break;
            case "desktop.updated": {
              // Only a move into "running" counts as the agent opening it.
              const previous = queryClient.getQueryData<DesktopStatusValue>(keys.desktop(taskId));
              const next = applyDesktopStatus(previous, event.desktop, "event");
              if (next === previous) break;
              queryClient.setQueryData(keys.desktop(taskId), next);
              if (previous !== undefined && previous.status.state !== "running" && next.status.state === "running") {
                setDesktopOpens((n) => n + 1);
              }
              break;
            }
          }
        },
        onClose: reconnect,
      });
    };
    open().catch(reconnect);

    return () => {
      active = false;
      clearTimeout(retry);
      close?.();
    };
  }, [api, taskId, generation, queryClient]);

  const running = runs.data?.some((run) => run.status === "running") === true;
  // A cold failure leaves content missing: the thread says so inline instead of showing an empty chat or a banner.
  const { loadError, error } = threadErrors([task, messages, runs], disconnected, running);

  return {
    task: task.data ?? null,
    messages: messages.data ?? [],
    runs: runs.data ?? [],
    desktop: desktop.data ?? null,
    output,
    desktopOpens,
    error,
    loadError,
  };
}

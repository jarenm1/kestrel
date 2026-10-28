import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { Message, Run } from "@/api/types";
import { openTaskEvents } from "@/api/events";
import { keys, upsert, createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";

const MAX_LOG_LINES = 2000;
const RECONNECT_MS = 2000;

/**
 * Task chat state: REST snapshots in the query cache, kept current by the task events WebSocket.
 * Mirror of the webapp's useTaskState hook.
 */
export function useTaskState(taskId: string) {
  const queryClient = useQueryClient();
  const { api, serverUrl } = useApiClient();
  const queries = useMemo(() => createQueries(api), [api]);

  const [task, messages, runs] = useQueries({
    queries: [queries.task(taskId), queries.messages(taskId), queries.runs(taskId)],
  });

  const [output, setOutput] = useState<Record<string, string[]>>({});
  const [disconnected, setDisconnected] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!serverUrl) return;

    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const close = openTaskEvents(serverUrl, taskId, {
      onOpen: () => {
        setDisconnected(false);
        void queryClient.invalidateQueries({ queryKey: keys.task(taskId) });
      },
      onEvent: (event) => {
        switch (event._tag) {
          case "task.updated":
            queryClient.setQueryData(keys.task(taskId), event.task);
            break;
          case "message.created":
            queryClient.setQueryData(
              keys.messages(taskId),
              (list: Message[] | undefined) => upsert(list, event.message)
            );
            break;
          case "run.updated":
            queryClient.setQueryData(
              keys.runs(taskId),
              (list: Run[] | undefined) => upsert(list, event.run)
            );
            break;
          case "agent.output":
            setOutput((prev) => ({
              ...prev,
              [event.runId]: [
                ...(prev[event.runId] ?? []),
                ...event.text.split("\n"),
              ].slice(-MAX_LOG_LINES),
            }));
            break;
          case "desktop.updated":
            break;
        }
      },
      onClose: () => {
        if (!active) return;
        setDisconnected(true);
        retry = setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS);
      },
    });

    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      close();
    };
  }, [taskId, generation, queryClient, serverUrl]);

  const failed = [task, messages, runs].find((q) => q.error);
  const errorText = disconnected
    ? "Live updates disconnected; reconnecting…"
    : failed?.error
      ? failed.error instanceof Error
        ? failed.error.message
        : String(failed.error)
      : null;

  return {
    task: task.data ?? null,
    messages: messages.data ?? [],
    runs: runs.data ?? [],
    output,
    error: errorText,
  };
}


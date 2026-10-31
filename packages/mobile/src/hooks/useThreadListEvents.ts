import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Paths, type ServerEvent, type Task } from "@cloudagents/protocol";
import { openEventStream, reconnectDelay } from "@/api/events";
import { keys, storeTask } from "@/api/queries";
import { useAuth } from "@/auth/AuthContext";
import { useApiClient } from "@/hooks/useApiClient";
import { useAppActive } from "@/hooks/useAppActive";

/**
 * Keeps the thread list current from the active box's user-events stream: `task.updated` writes the task into the list
 * (new threads included) and `task.deleted` drops it. The stream is open while signed in with a box and the app is in
 * the foreground. Each (re)connect re-reads the list, which catches changes missed meanwhile; reconnects back off.
 */
export function useThreadListEvents(): void {
  const { api } = useApiClient();
  const { user, activeBox } = useAuth();
  const queryClient = useQueryClient();
  const foreground = useAppActive();
  const failures = useRef(0);
  const live = user !== null && activeBox !== null && foreground;

  useEffect(() => {
    if (!live) return;
    let active = true;
    let retry: number | undefined;
    let close: (() => void) | undefined;

    function reconnect() {
      if (!active) return;
      retry = setTimeout(connect, reconnectDelay(failures.current++));
    }

    // A box token that cannot be minted, or a socket that cannot be opened, reconnects like a dropped socket.
    function connect() {
      api.socketUrl(Paths.eventsWs).then((url) => {
        if (!active) return;
        close = openEventStream(url, {
          onOpen: () => {
            failures.current = 0;
            void queryClient.invalidateQueries({ queryKey: keys.tasks });
          },
          onEvent: (event) => applyListEvent(queryClient, event),
          onClose: reconnect,
        });
      }, reconnect);
    }

    connect();
    return () => {
      active = false;
      clearTimeout(retry);
      close?.();
    };
  }, [api, live, queryClient]);
}

function applyListEvent(queryClient: QueryClient, event: ServerEvent): void {
  switch (event._tag) {
    case "task.updated":
      storeTask(queryClient, event.task);
      break;
    case "task.deleted":
      queryClient.setQueryData(keys.tasks, (list: readonly Task[] | undefined) =>
        list?.filter((task) => task.id !== event.taskId),
      );
      queryClient.removeQueries({ queryKey: keys.task(event.taskId), exact: true });
      break;
  }
}

import type { ServerEvent } from "./types";
import { Paths } from "./types";

/**
 * Opens a WebSocket connection to the task's event stream.
 * Returns a cleanup function that closes the socket.
 */
export function openTaskEvents(
  serverUrl: string,
  taskId: string,
  handlers: {
    onOpen: () => void;
    onEvent: (event: ServerEvent) => void;
    onClose: () => void;
  }
): () => void {
  const wsUrl = serverUrl.replace(/^http/, "ws") + Paths.taskEventsWs(taskId);
  const socket = new WebSocket(wsUrl);

  socket.onopen = handlers.onOpen;

  socket.onmessage = (msg) => {
    if (typeof msg.data !== "string") return;
    try {
      const event: ServerEvent = JSON.parse(msg.data);
      if (event && event._tag) handlers.onEvent(event);
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onclose = handlers.onClose;

  return () => {
    socket.onclose = null;
    socket.close();
  };
}


import { Option, Schema } from "effect";
import { Paths, ServerEvent } from "@cloudagents/protocol";

const decodeEvent = Schema.decodeUnknownOption(ServerEvent);

/**
 * Opens a WebSocket connection to the task's event stream. Frames that do not decode as a ServerEvent are ignored.
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      return;
    }
    const event = decodeEvent(parsed);
    if (Option.isSome(event)) handlers.onEvent(event.value);
  };

  socket.onclose = handlers.onClose;

  return () => {
    socket.onclose = null;
    socket.close();
  };
}

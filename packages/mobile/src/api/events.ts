import { Option, Schema } from "effect";
import { ServerEvent, TaskStats } from "@cloudagents/protocol";

const decodeEvent = Schema.decodeUnknownOption(ServerEvent);
const decodeTaskStats = Schema.decodeUnknownOption(TaskStats);

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/** How long to wait before reconnect attempt `failures` (0 before the first retry). A socket that opens resets the count. */
export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** failures);
}

/**
 * Opens a WebSocket to a ServerEvent stream at `wsUrl` (from `ApiClient.socketUrl`): a task's events or the user's thread list. Frames that do not decode as a ServerEvent are ignored.
 * Returns a cleanup function that closes the socket.
 */
export function openEventStream(
  wsUrl: string,
  handlers: {
    onOpen: () => void;
    onEvent: (event: ServerEvent) => void;
    onClose: () => void;
  }
): () => void {
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

/**
 * Subscribes to a task's stats stream at `wsUrl` (from `ApiClient.socketUrl`): the first frame carries the window so far, later frames carry new samples.
 * Returns a cleanup function that closes the socket.
 */
export function openTaskStats(
  wsUrl: string,
  handlers: { onOpen: () => void; onFrame: (stats: TaskStats) => void; onClose: () => void }
): () => void {
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
    const stats = decodeTaskStats(parsed);
    if (Option.isSome(stats)) handlers.onFrame(stats.value);
  };

  socket.onclose = handlers.onClose;

  return () => {
    socket.onclose = null;
    socket.close();
  };
}

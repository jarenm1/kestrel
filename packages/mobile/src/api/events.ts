import { Option, Schema } from "effect";
import { ServerEvent, TaskStats } from "@cloudagents/protocol";

/** The first reconnect wait after a stream closes. */
export const RECONNECT_MS = 2000;
/** The longest reconnect wait: backoff caps at one attempt a minute. */
export const RECONNECT_MAX_MS = 60_000;

/**
 * The wait before reconnect attempt `attempts` (0-based): RECONNECT_MS, doubling to RECONNECT_MAX_MS. A dead target
 * must not be retried every couple of seconds forever — but a capped retry still catches a box that comes back.
 */
export function reconnectDelay(attempts: number): number {
  return Math.min(RECONNECT_MS * 2 ** attempts, RECONNECT_MAX_MS);
}

const decodeEvent = Schema.decodeUnknownOption(ServerEvent);
const decodeTaskStats = Schema.decodeUnknownOption(TaskStats);

/**
 * Opens a WebSocket connection to the task's event stream at `wsUrl` (from `ApiClient.socketUrl`). Frames that do not decode as a ServerEvent are ignored.
 * Returns a cleanup function that closes the socket.
 */
export function openTaskEvents(
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
  handlers: { onFrame: (stats: TaskStats) => void; onClose: () => void }
): () => void {
  const socket = new WebSocket(wsUrl);

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

import type { AgentItem, Message, Run } from "@cloudagents/protocol";

/**
 * The thread data the shared transcript renders (`@cloudagents/ui/transcript`), kept in sync across Expo's DOM bridge.
 * The native side sends it whole once per epoch (a prop), then only what changed (`TranscriptPatch`, through the DOM
 * component's ref): re-sending a long thread on every streamed token would serialize it many times a second.
 */
export interface TranscriptData {
  readonly taskId: string;
  readonly messages: readonly Message[];
  readonly runs: readonly Run[];
  readonly runItems: Readonly<Record<string, readonly AgentItem[]>>;
  readonly pendingAskId: string | undefined;
}

/** `TranscriptData` as of `epoch`; patches of the same epoch apply on top of it, in `seq` order from 1. */
export interface TranscriptSnapshot extends TranscriptData {
  readonly epoch: number;
}

/** A list's new tail: keep the first `start` entries, then `items`. Live updates replace or append at the end. */
export interface TailPatch<T> {
  readonly start: number;
  readonly items: readonly T[];
}

export interface TranscriptPatch {
  readonly epoch: number;
  readonly seq: number;
  readonly messages?: TailPatch<Message>;
  readonly runs?: TailPatch<Run>;
  readonly runItems?: Readonly<Record<string, TailPatch<AgentItem>>>;
  readonly pendingAskId: string | undefined;
}

/**
 * What changed from `prev` to `next`, by identity: the query cache replaces an entry's object when it changes and keeps
 * the rest, so the first entry that differs starts the tail. Null when nothing did.
 */
export function tailPatch<T>(prev: readonly T[], next: readonly T[]): TailPatch<T> | null {
  if (prev === next) return null;
  const shared = Math.min(prev.length, next.length);
  let start = 0;
  while (start < shared && prev[start] === next[start]) start += 1;
  if (start === prev.length && start === next.length) return null;
  return { start, items: next.slice(start) };
}

export function applyTail<T>(list: readonly T[], patch: TailPatch<T> | undefined): readonly T[] {
  if (patch === undefined) return list;
  return [...list.slice(0, patch.start), ...patch.items];
}

const NONE: readonly never[] = [];

/** The changes from `prev` to `next` of one thread, or null when there are none. */
export function diffTranscript(
  prev: TranscriptData,
  next: TranscriptData
): Omit<TranscriptPatch, "epoch" | "seq"> | null {
  const messages = tailPatch(prev.messages, next.messages);
  const runs = tailPatch(prev.runs, next.runs);
  let runItems: Record<string, TailPatch<AgentItem>> | undefined;
  for (const [runId, items] of Object.entries(next.runItems)) {
    const patch = tailPatch(prev.runItems[runId] ?? NONE, items);
    if (patch !== null) (runItems ??= {})[runId] = patch;
  }
  if (messages === null && runs === null && runItems === undefined && prev.pendingAskId === next.pendingAskId) {
    return null;
  }
  return {
    ...(messages === null ? {} : { messages }),
    ...(runs === null ? {} : { runs }),
    ...(runItems === undefined ? {} : { runItems }),
    pendingAskId: next.pendingAskId,
  };
}

export function applyTranscriptPatch(data: TranscriptData, patch: Omit<TranscriptPatch, "epoch" | "seq">): TranscriptData {
  let runItems = data.runItems;
  if (patch.runItems !== undefined) {
    const updated: Record<string, readonly AgentItem[]> = { ...data.runItems };
    for (const [runId, tail] of Object.entries(patch.runItems)) updated[runId] = applyTail(updated[runId] ?? NONE, tail);
    runItems = updated;
  }
  return {
    taskId: data.taskId,
    messages: applyTail(data.messages, patch.messages),
    runs: applyTail(data.runs, patch.runs),
    runItems,
    pendingAskId: patch.pendingAskId,
  };
}

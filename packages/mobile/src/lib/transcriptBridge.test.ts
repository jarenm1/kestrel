import { describe, expect, test } from "bun:test";
import type { AgentItem, Message, Run } from "@cloudagents/protocol";
import { applyTranscriptPatch, diffTranscript, type TranscriptData } from "./transcriptBridge";

const message = (id: string, text = id) => ({ id, text }) as unknown as Message;
const run = (id: string, status = "running") => ({ id, status }) as unknown as Run;
const item = (id: string, text = id) => ({ id, text }) as unknown as AgentItem;

const base: TranscriptData = {
  taskId: "t",
  messages: [message("m1"), message("m2")],
  runs: [run("r1")],
  runItems: { r1: [item("a"), item("b")] },
  pendingAskId: undefined,
};

/** The DOM side's copy after the patch must equal what the native side has. */
function roundTrip(next: TranscriptData) {
  const patch = diffTranscript(base, next);
  expect(patch).not.toBeNull();
  const applied = applyTranscriptPatch(base, patch!);
  expect(applied.messages).toEqual(next.messages);
  expect(applied.runs).toEqual(next.runs);
  expect(applied.runItems).toEqual(next.runItems);
  expect(applied.pendingAskId).toBe(next.pendingAskId);
  return patch!;
}

describe("transcript bridge", () => {
  test("nothing changed: no patch", () => {
    expect(diffTranscript(base, { ...base, runItems: { ...base.runItems } })).toBeNull();
  });

  test("a streaming item sends only itself, not the thread", () => {
    const patch = roundTrip({ ...base, runItems: { r1: [base.runItems.r1![0]!, item("b", "b streamed")] } });
    expect(patch.runItems?.r1).toEqual({ start: 1, items: [item("b", "b streamed")] });
    expect(patch.messages).toBeUndefined();
    expect(patch.runs).toBeUndefined();
  });

  test("appends, a new run's items, replacements mid-list and a pending question all survive", () => {
    roundTrip({
      taskId: "t",
      messages: [message("m1", "edited"), message("m2"), message("m3")],
      runs: [run("r1", "succeeded"), run("r2")],
      runItems: { r1: base.runItems.r1!, r2: [item("c")] },
      pendingAskId: "m3",
    });
  });

  test("a refetch that reorders or drops entries replaces the tail from the first difference", () => {
    roundTrip({ ...base, messages: [message("m2")], runItems: { r1: [item("b"), item("a")] } });
  });
});

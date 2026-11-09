import { expect, test } from "bun:test";
import type { DesktopStatus } from "@cloudagents/protocol";
import { applyDesktopStatus } from "./desktopStatus";

const status = (state: DesktopStatus["state"]): DesktopStatus => ({
  taskId: "task-1",
  state,
  display: state === "stopped" ? null : ":101",
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "1080p30",
  error: null,
});

test("a mutation response that raced a newer event does not roll the desktop back", () => {
  const base = applyDesktopStatus(undefined, status("stopped"), "event");
  const live = applyDesktopStatus(base, status("running"), "event");
  const late = applyDesktopStatus(live, status("starting"), "mutation", base);
  expect(late).toBe(live);
  expect(late.status.state).toBe("running");
});

test("a mutation response lands when nothing else wrote while it was in flight", () => {
  const base = applyDesktopStatus(undefined, status("stopped"), "event");
  const next = applyDesktopStatus(base, status("starting"), "mutation", base);
  expect(next.status.state).toBe("starting");
  expect(next.source).toBe("mutation");
  expect(next.revision).toBe(base.revision + 1);
});

test("a newer event still lands over a mutation response", () => {
  const base = applyDesktopStatus(undefined, status("running"), "event");
  const mutation = applyDesktopStatus(base, status("stopped"), "mutation", base);
  const event = applyDesktopStatus(mutation, status("running"), "event");
  expect(event.status.state).toBe("running");
  expect(event.source).toBe("event");
});

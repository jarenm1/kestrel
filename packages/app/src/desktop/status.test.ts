import { expect, test } from "bun:test"
import type { DesktopStatus } from "@cloudagents/protocol"
import { applyDesktopStatus, DesktopStreamAuthority, isDesktopStreamActive } from "./status"

const status = (state: DesktopStatus["state"]): DesktopStatus => ({
  taskId: "task-1",
  state,
  display: state === "stopped" ? null : ":101",
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "1080p30",
  error: null,
})

test("a mutation response that raced a newer status frame does not roll the desktop back", () => {
  const base = applyDesktopStatus(undefined, status("stopped"), "event")
  const live = applyDesktopStatus(base, status("running"), "stream")
  const late = applyDesktopStatus(live, status("starting"), "mutation", base)
  expect(late).toBe(live)
  expect(late.status.state).toBe("running")
})

test("a mutation response lands when nothing else wrote while it was in flight", () => {
  const base = applyDesktopStatus(undefined, status("stopped"), "event")
  const next = applyDesktopStatus(base, status("starting"), "mutation", base)
  expect(next.status.state).toBe("starting")
  expect(next.source).toBe("mutation")
  expect(next.revision).toBe(base.revision + 1)
})

test("a late status frame is the box's truth and lands over a mutation response", () => {
  const base = applyDesktopStatus(undefined, status("running"), "event")
  const mutation = applyDesktopStatus(base, status("stopped"), "mutation", base)
  const frame = applyDesktopStatus(mutation, status("running"), "stream")
  expect(frame.status.state).toBe("running")
  expect(frame.source).toBe("stream")
})

test("while a viewer streams, a backlogged desktop.updated event does not overwrite its frames", () => {
  const frame = applyDesktopStatus(undefined, status("running"), "stream")
  const event = applyDesktopStatus(frame, status("starting"), "event", undefined, true)
  expect(event).toBe(frame)
  // Without a mounted stream the event is the only writer.
  const fallback = applyDesktopStatus(frame, status("stopped"), "event")
  expect(fallback.status.state).toBe("stopped")
})

test("after the stream closes, a stopped event clears the running cache", () => {
  const authority = new DesktopStreamAuthority()
  authority.frame("task-1")
  const running = applyDesktopStatus(undefined, status("running"), "stream")
  authority.close()
  const stopped = applyDesktopStatus(running, status("stopped"), "event", undefined, isDesktopStreamActive("task-1"))
  expect(stopped.status.state).toBe("stopped")
})

test("stream authority is claimed by a frame and released when the socket closes", () => {
  const authority = new DesktopStreamAuthority()
  authority.frame("authority-a")
  expect(isDesktopStreamActive("authority-a")).toBe(true)
  // Moving to another task releases the previous one: only the open socket's task is authoritative.
  authority.frame("authority-b")
  expect(isDesktopStreamActive("authority-a")).toBe(false)
  expect(isDesktopStreamActive("authority-b")).toBe(true)
  authority.close()
  expect(isDesktopStreamActive("authority-b")).toBe(false)
})

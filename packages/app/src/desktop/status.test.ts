import { expect, test } from "bun:test"
import type { DesktopStatus } from "@cloudagents/protocol"
import { applyDesktopStatus } from "@cloudagents/protocol"
import { DesktopStreamAuthority, isDesktopStreamActive } from "./status"

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

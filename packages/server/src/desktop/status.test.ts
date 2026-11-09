import { describe, expect, test } from "bun:test"
import { desktopStatus, type DesktopStatusSource } from "./status"

const source = (overrides: Partial<DesktopStatusSource> = {}): DesktopStatusSource => ({
  state: "running",
  display: ":101",
  quality: "720p60",
  error: null,
  streaming: true,
  ...overrides,
})

describe("desktopStatus", () => {
  test("a missing session is stopped, not streaming, and not attachable", () => {
    expect(desktopStatus("task", undefined)).toMatchObject({
      state: "stopped",
      display: null,
      streaming: false,
      quality: "1080p30",
    })
  })

  test("a failed session keeps its error but exposes no display to attach to", () => {
    expect(desktopStatus("task", source({ state: "failed", error: "encoder exited", streaming: false }))).toMatchObject({
      state: "failed",
      display: null,
      error: "encoder exited",
      streaming: false,
    })
  })

  test("streaming is encoder presence, not the lifecycle state", () => {
    // A running desktop whose encoder idled out is attachable but not streaming.
    expect(desktopStatus("task", source({ streaming: false }))).toMatchObject({
      state: "running",
      display: ":101",
      streaming: false,
    })
    // A starting desktop has an encoder booting before any frame is flowing.
    expect(desktopStatus("task", source({ state: "starting", streaming: true }))).toMatchObject({
      state: "starting",
      display: ":101",
      streaming: true,
    })
  })
})

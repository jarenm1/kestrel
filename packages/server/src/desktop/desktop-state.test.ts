import { expect, test } from "bun:test"
import { transitionDesktop, type DesktopEvent, type DesktopPhase } from "./desktop-state"

const stopped: DesktopPhase = { state: "stopped", error: null }
const starting: DesktopPhase = { state: "starting", error: null }
const running: DesktopPhase = { state: "running", error: null }
const failed: DesktopPhase = { state: "failed", error: "boot failed" }

const apply = (event: DesktopEvent, phase: DesktopPhase = starting) => transitionDesktop(phase, event)

test("a desktop starts only from stopped or failed", () => {
  expect(apply({ _tag: "started" }, stopped)).toMatchObject({
    _tag: "transitioned",
    phase: { state: "starting", error: null },
  })
  expect(apply({ _tag: "started" }, failed)).toMatchObject({
    _tag: "transitioned",
    phase: { state: "starting", error: null },
  })
  for (const phase of [starting, running]) {
    expect(apply({ _tag: "started" }, phase)).toEqual({ _tag: "illegal", reason: "already-active" })
  }
})

test("the first config is the only starting -> running edge", () => {
  expect(apply({ _tag: "configured" })._tag).toBe("transitioned")
  for (const phase of [stopped, running, failed]) {
    expect(apply({ _tag: "configured" }, phase)).toEqual({ _tag: "illegal", reason: "not-active" })
  }
})

test("a failure records its message and is legal only while active", () => {
  expect(apply({ _tag: "failed", message: "encoder died" })).toEqual({
    _tag: "transitioned",
    phase: { state: "failed", error: "encoder died" },
    changed: true,
  })
  expect(apply({ _tag: "failed", message: "x" }, running)).toMatchObject({
    _tag: "transitioned",
    phase: { state: "failed", error: "x" },
  })
  for (const phase of [stopped, failed]) {
    expect(apply({ _tag: "failed", message: "x" }, phase)).toEqual({ _tag: "illegal", reason: "not-active" })
  }
})

test("stopping clears the error and is idempotent", () => {
  expect(apply({ _tag: "stopped" }, failed)).toEqual({
    _tag: "transitioned",
    phase: { state: "stopped", error: null },
    changed: true,
  })
  expect(apply({ _tag: "stopped" }, stopped)).toEqual({
    _tag: "transitioned",
    phase: { state: "stopped", error: null },
    changed: false,
  })
})

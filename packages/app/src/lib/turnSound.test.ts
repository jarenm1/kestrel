import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Task } from "@cloudagents/protocol"
import { getTurnVolume, observeTask, playTurnSound, TURN_VOLUME_KEY, type SeenTasks } from "./turnSound"

const task = (status: Task["status"], minute: number, archivedAt?: string): Task => ({
  id: "task",
  owner: "owner",
  title: "Thread",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: `2026-01-01T00:0${minute}:00.000Z`,
  checkouts: [],
  ...(archivedAt === undefined ? {} : { archivedAt }),
})

describe("observeTask", () => {
  test("a running thread that finishes, fails or asks for input is the user's turn", () => {
    for (const status of ["done", "failed", "needs_input"] as const) {
      const seen: SeenTasks = new Map()
      observeTask(seen, task("running", 1))
      expect(observeTask(seen, task(status, 2))).toBe(true)
    }
  })

  test("a delegated thread that ends is not the user's turn, but its asking for input is", () => {
    const delegation = { parentTaskId: "parent", parentRunId: "run", requestId: "request", fingerprint: "print" }
    for (const [status, turn] of [["done", false], ["failed", false], ["needs_input", true]] as const) {
      const seen: SeenTasks = new Map()
      observeTask(seen, { ...task("running", 1), delegation })
      expect(observeTask(seen, { ...task(status, 2), delegation })).toBe(turn)
    }
  })

  test("a first sighting, a cancel and an archived thread are not", () => {
    const seen: SeenTasks = new Map()
    expect(observeTask(seen, task("done", 1))).toBe(false)
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("idle", 2))).toBe(false)
    observeTask(seen, task("running", 3))
    expect(observeTask(seen, task("done", 4, "2026-01-01T00:04:00.000Z"))).toBe(false)
  })

  test("a snapshot showing a run started while disconnected arms the next event", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("done", 1))
    expect(observeTask(seen, task("running", 2))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(true)
  })

  test("a snapshot showing a run ended while disconnected is the user's turn, once", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("running", 1))
    expect(observeTask(seen, task("done", 2))).toBe(true)
    expect(observeTask(seen, task("done", 2))).toBe(false)
  })

  test("a snapshot older than an event is dropped", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("done", 1))
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("done", 1))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(true)
  })

  test("events queued behind a newer snapshot neither rearm nor replay", () => {
    const seen: SeenTasks = new Map()
    observeTask(seen, task("running", 2))
    expect(observeTask(seen, task("done", 3))).toBe(true)
    expect(observeTask(seen, task("running", 2))).toBe(false)
    expect(observeTask(seen, task("done", 3))).toBe(false)
  })
})

describe("volume", () => {
  const original = { localStorage: globalThis.localStorage, AudioContext: globalThis.AudioContext, window: globalThis.window }
  let stored: Map<string, string>
  let peaks: number[]

  beforeEach(() => {
    stored = new Map()
    peaks = []
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime: (value: number) => peaks.push(value) }
    const node = { connect: () => node, start() {}, stop() {}, gain: param, frequency: param, type: "" }
    Object.assign(globalThis, {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
      window: { setTimeout: () => 0 },
      AudioContext: class {
        currentTime = 0
        destination = node
        resume = async () => {}
        close = async () => {}
        createOscillator = () => node
        createGain = () => node
      },
    })
  })

  afterEach(() => {
    Object.assign(globalThis, original)
  })

  test("an unset or invalid stored volume falls back to the default", () => {
    expect(getTurnVolume()).toBe(50)
    for (const bad of ["", "abc", "-5", "101", "1.5"]) {
      stored.set(TURN_VOLUME_KEY, bad)
      expect(getTurnVolume()).toBe(50)
    }
  })

  test("a stored volume is read back, zero included", () => {
    stored.set(TURN_VOLUME_KEY, "0")
    expect(getTurnVolume()).toBe(0)
    stored.set(TURN_VOLUME_KEY, "80")
    expect(getTurnVolume()).toBe(80)
  })

  test("the clip's peak scales with the volume", () => {
    playTurnSound("bell", 100)
    expect(peaks.filter((peak) => peak > 0.001)).toEqual([0.3, 0.3])
    peaks = []
    playTurnSound("bell", 50)
    expect(peaks.filter((peak) => peak > 0.001)).toEqual([0.15, 0.15])
  })

  test("zero volume and off play nothing", () => {
    playTurnSound("bell", 0)
    playTurnSound("off", 100)
    expect(peaks).toEqual([])
  })
})

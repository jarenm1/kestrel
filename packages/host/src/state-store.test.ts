import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileAtomic } from "./fs-atomic"
import { MAX_COMMAND_OUTCOMES, findCommand, markCommandsReported, pendingCommands, recordCommand, stateLayout, type StateLayout } from "./state-store"

let dir: string
let layout: StateLayout

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-state-"))
  layout = stateLayout(dir)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const outcome = (commandId: string, ok = true) => ({
  commandId,
  boxId: "box-1",
  ok,
  reported: false,
  ...(ok ? {} : { error: "boom" }),
})

describe("command outcomes", () => {
  test("a recorded outcome is found again by its command id, so a resent command is not run twice", () => {
    recordCommand(layout, outcome("cmd-1", false))
    expect(findCommand(layout, "cmd-1")).toEqual({ ...outcome("cmd-1", false) })
    expect(findCommand(layout, "cmd-2")).toBeNull()
  })

  test("recording the same command id again replaces the earlier outcome", () => {
    recordCommand(layout, outcome("cmd-1", false))
    recordCommand(layout, outcome("cmd-1", true))
    expect(pendingCommands(layout)).toEqual([outcome("cmd-1", true)])
  })

  test("an outcome stays pending until it is marked reported", () => {
    recordCommand(layout, outcome("cmd-1"))
    recordCommand(layout, outcome("cmd-2"))
    markCommandsReported(layout, ["cmd-1"])
    expect(pendingCommands(layout).map((entry) => entry.commandId)).toEqual(["cmd-2"])
    expect(findCommand(layout, "cmd-1")?.reported).toBe(true)
  })

  test("only the newest MAX_COMMAND_OUTCOMES are remembered", () => {
    for (let index = 0; index <= MAX_COMMAND_OUTCOMES; index += 1) {
      recordCommand(layout, outcome(`cmd-${index}`))
    }
    expect(findCommand(layout, "cmd-0")).toBeNull()
    expect(findCommand(layout, `cmd-${MAX_COMMAND_OUTCOMES}`)).not.toBeNull()
  }, 60_000)
})

describe("writeFileAtomic", () => {
  test("replaces content and leaves only the target file", () => {
    const target = join(dir, "data.json")
    writeFileAtomic(target, "first")
    writeFileAtomic(target, "second")
    expect(readFileSync(target, "utf8")).toBe("second")
    expect(readdirSync(dir)).toEqual(["data.json"])
  })
})

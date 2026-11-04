import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireVmLock, LockBusyError, withVmLock } from "./lock"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-lock-"))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A pid that has just exited: no live process owns it. */
const exitedPid = (): number => {
  const result = spawnSync(process.execPath, ["-e", "0"])
  if (typeof result.pid !== "number") throw new Error("spawnSync returned no pid")
  return result.pid
}

describe("per-directory lock", () => {
  test("a second acquire while the lock is held is refused", () => {
    const held = acquireVmLock(dir)
    expect(() => acquireVmLock(dir)).toThrow(LockBusyError)
    held.release()
  })

  test("release frees the lock for the next owner", () => {
    acquireVmLock(dir).release()
    expect(existsSync(join(dir, "lock"))).toBe(false)
    acquireVmLock(dir).release()
  })

  test("withVmLock releases the lock when the callback throws", async () => {
    await expect(
      withVmLock(dir, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    acquireVmLock(dir).release()
  })

  test("a lock left by a dead process is stale and is broken", () => {
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: exitedPid(), startTime: 1, token: randomUUID() }))
    acquireVmLock(dir).release()
  })

  test("a lock whose pid is alive but whose start time differs is stale (pid reuse)", () => {
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: process.pid, startTime: 1, token: randomUUID() }))
    acquireVmLock(dir).release()
  })

  test("a malformed lock file is not trusted as a live owner", () => {
    writeFileSync(join(dir, "lock"), "garbage")
    acquireVmLock(dir).release()
  })
})

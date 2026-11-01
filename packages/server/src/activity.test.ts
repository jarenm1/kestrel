import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { openActivitySocket, type ActivitySocket } from "./activity"

let dir: string
let socket: ActivitySocket | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kt-activity-"))
})

afterEach(async () => {
  if (socket !== null) await Effect.runPromise(socket.close)
  socket = null
  rmSync(dir, { recursive: true, force: true })
})

const open = async (read: Effect.Effect<{ runs: number; desktops: number }>) => {
  socket = await Effect.runPromise(openActivitySocket(join(dir, "box.sock"), read))
  return socket
}

describe("openActivitySocket", () => {
  test("GET /activity reports the counts read at request time", async () => {
    let runs = 0
    await open(Effect.sync(() => ({ runs, desktops: 1 })))
    expect(await (await fetch("http://box/activity", { unix: join(dir, "box.sock") })).json()).toEqual({
      runs: 0,
      desktops: 1,
    })
    runs = 3
    expect(await (await fetch("http://box/activity", { unix: join(dir, "box.sock") })).json()).toEqual({
      runs: 3,
      desktops: 1,
    })
  })

  test("any other path or method is 404", async () => {
    await open(Effect.succeed({ runs: 0, desktops: 0 }))
    const unix = join(dir, "box.sock")
    expect((await fetch("http://box/health", { unix })).status).toBe(404)
    expect((await fetch("http://box/activity", { unix, method: "POST" })).status).toBe(404)
  })

  test("the socket is owner-only", async () => {
    await open(Effect.succeed({ runs: 0, desktops: 0 }))
    expect(statSync(join(dir, "box.sock")).mode & 0o777).toBe(0o600)
  })

  test("close stops answering and removes the socket file", async () => {
    const opened = await open(Effect.succeed({ runs: 0, desktops: 0 }))
    await Effect.runPromise(opened!.close)
    socket = null
    expect(existsSync(join(dir, "box.sock"))).toBe(false)
  })

  test("a path too long for a Unix socket opens nothing and does not throw", async () => {
    const longDir = join(dir, "x".repeat(120))
    const result = await Effect.runPromise(
      openActivitySocket(join(longDir, "box.sock"), Effect.succeed({ runs: 0, desktops: 0 })),
    )
    expect(result).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BOX_USER_HEADER, MAX_RELAY_RESPONSE_BYTES, type BoxCapabilities, NotFound, Paths, type RunClip, type ThreadPullRequestAction } from "@cloudagents/protocol"
import type { CoreShape } from "../core/service"
import { makeWebHandler, type RouterHooks } from "./router"

const capabilities: BoxCapabilities = { version: 1, platform: "linux", sandbox: "off", desktop: "unavailable" }

const handlerFor = (core: Partial<CoreShape>, hooks?: RouterHooks) =>
  Effect.runPromise(makeWebHandler(core as CoreShape, {} as never, capabilities, {} as never, hooks))

/** A request as the relay presents it: signed in as alice, with a JSON content type for bodies. */
const request = (path: string, init: { readonly method?: string; readonly body?: string } = {}) =>
  new Request(`http://box.test${path}`, {
    method: init.method ?? "GET",
    headers: { [BOX_USER_HEADER]: "alice", "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: init.body }),
  })

const postAction = (body: unknown) =>
  request(Paths.taskPullRequestAction("t1"), { method: "POST", body: JSON.stringify(body) })

describe("pull request routes", () => {
  test("a missing repo or a bad number is BadRequest before the core is asked", async () => {
    const handler = await handlerFor({})
    for (const path of [
      "/api/tasks/t1/pull-request?number=7",
      "/api/tasks/t1/pull-request?repo=acme/widget",
      "/api/tasks/t1/pull-request?repo=acme/widget&number=0",
      "/api/tasks/t1/pull-request?repo=acme/widget&number=nope",
      "/api/tasks/t1/pull-request/diff?number=7",
    ]) {
      const response = await handler(request(path))
      expect(response.status).toBe(400)
      expect((await response.json())._tag).toBe("BadRequest")
    }
  })

  test("an action body that does not decode is BadRequest", async () => {
    const handler = await handlerFor({})
    for (const body of [
      { action: "review", repo: "acme/widget", number: 7, body: "looks good", verdict: "bogus" },
      { action: "merge", repo: "acme/widget", number: 7 },
      { action: "close", repo: "acme/widget", number: -1 },
      { action: "watch", repo: "acme/widget", number: 7 },
      { action: "explode", repo: "acme/widget", number: 7 },
    ]) {
      const response = await handler(postAction(body))
      expect(response.status).toBe(400)
      expect((await response.json())._tag).toBe("BadRequest")
    }
  })

  test("an unknown route is NotFound", async () => {
    const handler = await handlerFor({})
    for (const path of ["/api/no-such-route", "/api/tasks/t1/pull-requests/extra", "/api/tasks/t1/pull-request/action/extra"]) {
      const response = await handler(request(path))
      expect(response.status).toBe(404)
    }
  })

  test("the review verdict reaches the core as the view sent it", async () => {
    const received: string[] = []
    const handler = await handlerFor({
      actOnPullRequest: (_user: string, _taskId: string, action: ThreadPullRequestAction) => {
        received.push(action.action === "review" ? `${action.action} ${action.verdict}` : action.action)
        return Effect.succeed({ id: "t1" } as never)
      },
    } as unknown as Partial<CoreShape>)
    for (const verdict of ["approve", "request-changes", "comment"]) {
      const response = await handler(
        postAction({ action: "review", repo: "acme/widget", number: 7, body: "ship it", verdict }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).id).toBe("t1")
    }
    expect(received).toEqual(["review approve", "review request-changes", "review comment"])
  })

  test("a watch checks ownership, tells the control plane, then records it", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => {
          events.push("check")
          return Effect.succeed({ watching: false })
        },
        actOnPullRequest: (_user: string, _taskId: string, action: ThreadPullRequestAction) => {
          events.push(`record ${action.action}`)
          return Effect.succeed({ id: "t1" } as never)
        },
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: (_user, _taskId, repo, number, watching) => {
          events.push(`hook ${repo}#${number} ${watching}`)
          return Effect.void
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 7, watching: true }))
    expect(response.status).toBe(200)
    expect(events).toEqual(["check", "hook acme/widget#7 true", "record watch"])
  })

  test("a watch of a pull request the thread does not own never reaches the control plane", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => {
          events.push("check")
          return Effect.fail(new NotFound({ message: "this thread does not own acme/widget#99" }))
        },
        actOnPullRequest: () => {
          events.push("record")
          return Effect.succeed({ id: "t1" } as never)
        },
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: () => {
          events.push("hook")
          return Effect.void
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 99, watching: true }))
    expect(response.status).toBe(404)
    expect((await response.json())._tag).toBe("NotFound")
    expect(events).toEqual(["check"])
  })

  test("a control-plane failure records nothing and returns an error", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => {
          events.push("check")
          return Effect.succeed({ watching: false })
        },
        actOnPullRequest: () => {
          events.push("record")
          return Effect.succeed({ id: "t1" } as never)
        },
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: () => {
          events.push("hook")
          return Effect.fail({ message: "control plane is down" })
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 7, watching: true }))
    expect(response.status).toBe(500)
    expect((await response.json())._tag).toBe("InternalError")
    expect(events).toEqual(["check", "hook"])
  })

  test("a failed registry write reverts the control plane to the prior registry state", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => Effect.succeed({ watching: false }),
        actOnPullRequest: () => Effect.fail({ _tag: "BadRequest", message: "task is archived; unarchive it first" } as never),
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: (_user, _taskId, _repo, _number, watching) => {
          events.push(`hook ${watching}`)
          return Effect.void
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 7, watching: true }))
    expect(response.status).toBe(400)
    expect((await response.json())._tag).toBe("BadRequest")
    expect(events).toEqual(["hook true", "hook false"])
  })

  test("a repeated watch whose registry write fails keeps the watch the registry still has", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => Effect.succeed({ watching: true }),
        actOnPullRequest: () => Effect.fail({ _tag: "BadRequest", message: "task is archived; unarchive it first" } as never),
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: (_user, _taskId, _repo, _number, watching) => {
          events.push(`hook ${watching}`)
          return Effect.void
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 7, watching: true }))
    expect(response.status).toBe(400)
    expect(events).toEqual(["hook true", "hook true"])
  })

  test("a failed unwatch re-adds no route the registry never had", async () => {
    const events: string[] = []
    const handler = await handlerFor(
      {
        requireOwnedPullRequest: () => Effect.succeed({ watching: false }),
        actOnPullRequest: () => Effect.fail({ _tag: "BadRequest", message: "task is archived; unarchive it first" } as never),
      } as unknown as Partial<CoreShape>,
      {
        watchPullRequest: (_user, _taskId, _repo, _number, watching) => {
          events.push(`hook ${watching}`)
          return Effect.void
        },
      },
    )
    const response = await handler(postAction({ action: "watch", repo: "acme/widget", number: 7, watching: false }))
    expect(response.status).toBe(400)
    expect(events).toEqual(["hook false", "hook false"])
  })
})

describe("clip routes", () => {
  const clip: RunClip = {
    id: `${"a".repeat(32)}.mp4`,
    caption: "Spawn demo",
    createdAt: "2026-11-06T10:00:00Z",
    durationMs: 1200,
    poster: `${"a".repeat(32)}.png`,
  }

  test("start carries the caption, stop returns the clip, and list returns the run's clips", async () => {
    const calls: string[] = []
    const handler = await handlerFor({
      evidenceStart: (_user: string, _taskId: string, _runId: string, caption?: string) => {
        calls.push(`start ${caption}`)
        return Effect.void
      },
      evidenceStop: () => {
        calls.push("stop")
        return Effect.succeed(clip)
      },
      runClips: () => {
        calls.push("list")
        return Effect.succeed({ clips: [clip] })
      },
    } as unknown as Partial<CoreShape>)
    const started = await handler(request(Paths.taskRunClips("t1", "r1"), { method: "POST", body: JSON.stringify({ caption: "Spawn demo" }) }))
    expect(started.status).toBe(204)
    const stopped = await handler(request(Paths.taskRunClips("t1", "r1"), { method: "DELETE" }))
    expect(stopped.status).toBe(200)
    const stoppedClip = await stopped.json()
    expect(stoppedClip.id).toBe(clip.id)
    expect(stoppedClip.caption).toBe("Spawn demo")
    const listed = await handler(request(Paths.taskRunClips("t1", "r1")))
    expect((await listed.json()).clips).toHaveLength(1)
    expect(calls).toEqual(["start Spawn demo", "stop", "list"])
  })

  test("a clip is served whole, as a byte range, and 416 when the range cannot be satisfied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clip-route-"))
    try {
      const path = join(dir, "clip.mp4")
      writeFileSync(path, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
      const handler = await handlerFor({
        runClip: () =>
          Effect.tryPromise({
            try: async () => {
              const handle = await open(path)
              const stat = await handle.stat()
              return { handle, size: stat.size, mimeType: "video/mp4" }
            },
            catch: () => new NotFound({ message: "no clip" }),
          }),
      } as unknown as Partial<CoreShape>)
      const url = Paths.taskRunClip("t1", "r1", "clip.mp4")
      const whole = await handler(request(url))
      expect(whole.status).toBe(200)
      expect(whole.headers.get("content-type")).toBe("video/mp4")
      expect(whole.headers.get("accept-ranges")).toBe("bytes")
      expect(new Uint8Array(await whole.arrayBuffer())).toEqual(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
      const partial = await handler(new Request(`http://box.test${url}`, {
        headers: { [BOX_USER_HEADER]: "alice", range: "bytes=2-5" },
      }))
      expect(partial.status).toBe(206)
      expect(partial.headers.get("content-range")).toBe("bytes 2-5/10")
      expect(new Uint8Array(await partial.arrayBuffer())).toEqual(Uint8Array.from([2, 3, 4, 5]))
      const bad = await handler(new Request(`http://box.test${url}`, {
        headers: { [BOX_USER_HEADER]: "alice", range: "bytes=20-30" },
      }))
      expect(bad.status).toBe(416)
      expect(bad.headers.get("content-range")).toBe("bytes */10")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test("a clip over the relay response cap is served as a capped short 206", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clip-route-"))
  try {
    const path = join(dir, "long.mp4")
    const size = MAX_RELAY_RESPONSE_BYTES + 1
    writeFileSync(path, new Uint8Array(size))
    const handler = await handlerFor({
      runClip: () =>
        Effect.tryPromise({
          try: async () => {
            const handle = await open(path)
            return { handle, size: (await handle.stat()).size, mimeType: "video/mp4" }
          },
          catch: () => new NotFound({ message: "no clip" }),
        }),
    } as unknown as Partial<CoreShape>)
    const url = Paths.taskRunClip("t1", "r1", "long.mp4")
    const whole = await handler(request(url))
    expect(whole.status).toBe(206)
    expect(whole.headers.get("content-length")).toBe(String(MAX_RELAY_RESPONSE_BYTES))
    expect(whole.headers.get("content-range")).toBe(`bytes 0-${MAX_RELAY_RESPONSE_BYTES - 1}/${size}`)
    expect(whole.headers.get("accept-ranges")).toBe("bytes")
    await whole.body?.cancel()
    const openEnded = await handler(new Request(`http://box.test${url}`, {
      headers: { [BOX_USER_HEADER]: "alice", range: "bytes=0-" },
    }))
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get("content-length")).toBe(String(MAX_RELAY_RESPONSE_BYTES))
    expect(openEnded.headers.get("content-range")).toBe(`bytes 0-${MAX_RELAY_RESPONSE_BYTES - 1}/${size}`)
    await openEnded.body?.cancel()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

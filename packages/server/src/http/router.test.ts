import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BOX_USER_HEADER, type BoxCapabilities, NotFound, Paths, type ThreadPullRequestAction } from "@cloudagents/protocol"
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

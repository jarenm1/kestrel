import { describe, expect, test } from "bun:test"
import { Effect, Runtime } from "effect"
import type { WsServices } from "../http/streams"
import { Unauthorized } from "./auth"
import { makeBoxActivityReporter } from "./box-activity"
import { makeDirectListener } from "./listener"

const token = "11111111-1111-4111-8111-111111111111"
const settings = { controlUrl: "http://control.invalid", boxId: "managed", boxSecret: "test-secret" }

const setup = () => {
  let now = Date.parse("2026-11-05T12:00:00.000Z")
  const activity = makeBoxActivityReporter(settings, { now: () => now })
  // HTTP routing does not run stream services or open an RTC channel.
  const runtime = Runtime.defaultRuntime as Runtime.Runtime<WsServices>
  const listener = makeDirectListener({
    auth: { authenticate: () => Effect.fail(new Unauthorized({ message: "no box token" })) },
    activity,
    core: { previewTokenFor: (candidate) => Effect.succeed(candidate === token ? { user: "alice", taskId: "task" } : null) },
    webHandler: async () => new Response("preview content"),
    runtime,
  })
  return { activity, listener, advance: (ms: number) => { now += ms } }
}

describe("preview activity", () => {
  for (const resource of ["frame", "subresource"] as const) {
    test(`${resource} requests keep the validated preview user active`, async () => {
      const { activity, listener, advance } = setup()
      const request = () => resource === "frame"
        ? new Request(`http://box.local/_preview/${token}/task/`)
        : new Request("http://box.local/assets/app.js", { headers: { referer: `http://box.local/_preview/${token}/task/` } })
      try {
        expect((await listener.handle(request())).status).toBe(200)
        advance(299_000)
        expect((await listener.handle(request())).status).toBe(200)
        advance(2_000)
        expect(activity.snapshot().users).toEqual([{ login: "alice", lastActiveAt: "2026-11-05T12:04:59.000Z" }])
        advance(298_000)
        expect(activity.snapshot().users).toEqual([])
      } finally {
        listener.close()
      }
    })
  }

  test("invalid preview tokens and task mismatches cannot refresh activity", async () => {
    const { activity, listener, advance } = setup()
    activity.record("alice")
    advance(299_000)
    try {
      for (const path of [`/_preview/22222222-2222-4222-8222-222222222222/task/`, `/_preview/${token}/other-task/`]) {
        expect((await listener.handle(new Request(`http://box.local${path}`))).status).toBe(404)
        expect((await listener.handle(new Request("http://box.local/app.js", { headers: { referer: `http://box.local${path}` } }))).status).toBe(404)
      }
      advance(1_000)
      expect(activity.snapshot().users).toEqual([])
    } finally {
      listener.close()
    }
  })
})

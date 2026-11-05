import { describe, expect, test } from "bun:test"
import { ACTIVITY_WINDOW_SECONDS, BOX_ID_HEADER, ControlPaths, MAX_BOX_ACTIVITY_USERS } from "@cloudagents/protocol"
import { makeBoxActivityReporter } from "./box-activity"

const CONTROL = "https://control.example"
const SETTINGS = { controlUrl: CONTROL, boxId: "box_fleet_1", boxSecret: "fleet-box-secret" }
const WINDOW_MS = ACTIVITY_WINDOW_SECONDS * 1000

interface Sent {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: { users: ReadonlyArray<{ login: string; lastActiveAt: string }> }
}

/** A control plane stub: records each report and answers with the next reply; `null` makes the call throw. */
const stubControl = (replies: Array<number | null>) => {
  const calls: Sent[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)]
    calls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
    })
    if (reply === null) throw new TypeError("control plane unreachable")
    return new Response(null, { status: reply ?? 204 })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const clock = () => {
  let now = 1_000
  return {
    now: () => now,
    advance: (by: number) => {
      now += by
    },
  }
}

describe("managed box activity report", () => {
  test("posts unique logins with their latest activity, authenticated as the box", async () => {
    const time = clock()
    const { calls, fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: time.now })

    reporter.record("alice")
    time.advance(1_000)
    reporter.record("alice")
    time.advance(1_000)
    reporter.record("bob")
    await reporter.send()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${CONTROL}${ControlPaths.boxActivity}`)
    expect(calls[0]?.headers.authorization).toBe("Bearer fleet-box-secret")
    expect(calls[0]?.headers[BOX_ID_HEADER]).toBe("box_fleet_1")
    expect(calls[0]?.headers["content-type"]).toBe("application/json")
    expect(calls[0]?.body.users).toEqual([
      { login: "alice", lastActiveAt: new Date(2_000).toISOString() },
      { login: "bob", lastActiveAt: new Date(3_000).toISOString() },
    ])
  })

  test("a box with no active users sends an empty snapshot", async () => {
    const { calls, fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: () => 0 })

    await reporter.send()

    expect(calls[0]?.body.users).toEqual([])
  })

  test("a login drops out once its last request is five minutes old", async () => {
    const time = clock()
    const { calls, fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: time.now })

    reporter.record("alice")
    time.advance(200_000)
    reporter.record("bob")

    time.advance(WINDOW_MS - 200_000)
    await reporter.send()
    expect(calls.at(-1)?.body.users.map((user) => user.login)).toEqual(["bob"])

    time.advance(200_000)
    await reporter.send()
    expect(calls.at(-1)?.body.users).toEqual([])
  })

  test("a later request makes an expired login active again, once", async () => {
    const time = clock()
    const { calls, fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: time.now })

    reporter.record("alice")
    time.advance(WINDOW_MS + 1)
    reporter.record("alice")
    await reporter.send()

    expect(calls[0]?.body.users).toEqual([{ login: "alice", lastActiveAt: new Date(time.now()).toISOString() }])
  })

  test("never holds more than the protocol's maximum of users", async () => {
    const time = clock()
    const { fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: time.now })

    for (let index = 0; index <= MAX_BOX_ACTIVITY_USERS; index++) {
      time.advance(1)
      reporter.record(`user-${index}`)
    }
    const report = reporter.snapshot()

    expect(report.users).toHaveLength(MAX_BOX_ACTIVITY_USERS)
    expect(report.users[0]?.login).toBe("user-1")
    expect(report.users.at(-1)?.login).toBe(`user-${MAX_BOX_ACTIVITY_USERS}`)
  })

  test("a failed report does not reject, and the next snapshot recovers", async () => {
    const { calls, fetchFn } = stubControl([null, 400, 204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: () => 1_000 })

    reporter.record("alice")
    await reporter.send()
    await reporter.send()
    await reporter.send()

    expect(calls).toHaveLength(3)
    expect(calls.at(-1)?.body.users.map((user) => user.login)).toEqual(["alice"])
  })

  test("start sends at once and ticks send again, and stop cancels the schedule", async () => {
    const { calls, fetchFn } = stubControl([204])
    const ticks: Array<() => void> = []
    let cancelled = 0
    const reporter = makeBoxActivityReporter(SETTINGS, {
      fetchFn,
      now: () => 1_000,
      schedule: (tick) => {
        ticks.push(tick)
        return () => {
          cancelled += 1
        }
      },
    })

    reporter.start()
    await reporter.send()
    expect(calls).toHaveLength(1)

    reporter.start()
    expect(ticks).toHaveLength(1)

    ticks[0]?.()
    await reporter.send()
    expect(calls).toHaveLength(2)

    reporter.stop()
    reporter.stop()
    expect(cancelled).toBe(1)
  })

  test("constructing a reporter and recording starts no timer and sends nothing", () => {
    const { calls, fetchFn } = stubControl([204])
    const reporter = makeBoxActivityReporter(SETTINGS, { fetchFn, now: () => 1_000 })

    reporter.record("alice")

    expect(calls).toHaveLength(0)
  })
})

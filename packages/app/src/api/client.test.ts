import { afterEach, describe, expect, mock, test } from "bun:test"
import { ControlPaths, Paths } from "@cloudagents/protocol"

// The app's config reads the page origin and Vite's env, neither of which exists under bun.
mock.module("@/config", () => ({ SERVER_URL: "https://control.test", WS_URL: "wss://control.test" }))
Object.assign(globalThis, {
  window: globalThis,
  location: { hostname: "app.test", protocol: "https:", port: "", origin: "https://app.test" },
})
const { api } = await import("./client")

const CONTROL = "https://control.test"
const BOX = "https://box.test"
const BOX_ID = "box-1"

const boxList = {
  boxes: [{ id: BOX_ID, name: "Desk", url: BOX, createdAt: "2026-11-01T00:00:00.000Z" }],
  activeBoxId: BOX_ID,
}

const task = {
  id: "thread-1",
  owner: "alice",
  title: "Offline thread",
  status: "idle",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  checkouts: [],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A fetch that answers the control plane and the box by path; `control` and `box` may stall or fail. */
function stubFetch(options: {
  readonly control?: (url: string) => Promise<Response>
  readonly box: () => Promise<Response>
}): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === `${CONTROL}${ControlPaths.boxes}`) {
      return options.control ? options.control(url) : json(boxList)
    }
    if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) {
      return json({ token: "t", url: BOX, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    }
    if (url === `${BOX}${Paths.tasks}`) return options.box()
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`)
  }) as typeof fetch
}

const realFetch = globalThis.fetch

describe("listTasks with the control plane and a user box", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("reads the box's threads when everything answers", async () => {
    stubFetch({ box: async () => json([task]) })
    const tasks = await api.listTasks()
    expect(tasks.map((t) => t.id)).toEqual(["thread-1"])
  })

  test("a control plane that stalls does not hold up the read: the last box list is used", async () => {
    // The box list is known from the previous read above; the box answers at once with a cached token.
    stubFetch({ control: () => new Promise<Response>(() => {}), box: async () => json([task]) })
    const started = Date.now()
    const tasks = await api.listTasks()
    const elapsed = Date.now() - started
    expect(tasks.map((t) => t.id)).toEqual(["thread-1"])
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  test("a box with no cached threads that waits out its 15 s control timeout is still listed", async () => {
    // Its offline fallback answers after its own 15 s control wait. It has no cached threads, so the list waits for it.
    const slow = entryFor("slow-box-1", "https://slow-1.test")
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [slow], activeBoxId: slow.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(slow.id)}`) return tokenFor(slow.url)
      if (url === `${slow.url}${Paths.tasks}`) {
        return new Promise<Response>((resolve) => setTimeout(() => resolve(json([taskFor("slow-thread")])), 15_500))
      }
      return undefined
    })
    const tasks = await api.listTasks()
    expect(tasks.map((t) => t.id)).toEqual(["slow-thread"])
  }, 40_000)
})

const BYOB_ENTRY = { id: BOX_ID, name: "Desk", url: BOX, createdAt: "2026-11-01T00:00:00.000Z" }

/** A fetch that answers each request by `answer`; a request it returns nothing for fails the test. */
function routes(answer: (url: string, method: string) => Promise<Response> | Response | undefined): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const reply = await answer(url, method)
    if (reply === undefined) throw new Error(`unexpected request ${method} ${url}`)
    return reply
  }) as typeof fetch
}

const tokenFor = (url: string) => json({ token: "t", url, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })

const entryFor = (id: string, url: string) => ({ id, name: id, url, createdAt: "2026-11-01T00:00:00.000Z" })

const taskFor = (id: string) => ({ ...task, id })

/** Lets a request that was just started reach the fetch stub, and a released one finish. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await tick()
}

describe("box list reads that answer after a change", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("a read that answers after a box switch does not undo the switch", async () => {
    const before = { boxes: [BYOB_ENTRY], activeBoxId: null }
    const after = { ...before, activeBoxId: BOX_ID }
    let releaseStaleRead: (response: Response) => void = () => {}
    let listReads = 0
    const boxCalls: string[] = []
    routes((url, method) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) {
        listReads += 1
        return listReads === 1 ? new Promise<Response>((resolve) => (releaseStaleRead = resolve)) : json(before)
      }
      if (url === `${CONTROL}${ControlPaths.activeBox}` && method === "PUT") return json(after)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) return tokenFor(BOX)
      if (url === `${BOX}${Paths.tasks}`) return json([task])
      if (url === `${BOX}${ControlPaths.cliLoginCancel("claude-cli")}`) {
        boxCalls.push(url)
        return json({})
      }
      return undefined
    })

    const pending = api.listTasks()
    await tick()
    const switched = await api.setActiveBox(BOX_ID)
    releaseStaleRead(json(before))
    expect((await pending).map((t) => t.id)).toEqual(["thread-1"])

    expect(switched.activeBoxId).toBe(BOX_ID)
    await api.cliLoginCancel("claude-cli")
    // The active-box call goes to the switched box, not to the stale list's choice.
    expect(boxCalls).toEqual([`${BOX}${ControlPaths.cliLoginCancel("claude-cli")}`])
  })

  test("a box list read that answers after a change returns the list the app holds", async () => {
    const before = { boxes: [BYOB_ENTRY], activeBoxId: null }
    const after = { ...before, activeBoxId: BOX_ID }
    let releaseStaleRead: (response: Response) => void = () => {}
    let listReads = 0
    routes((url, method) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) {
        listReads += 1
        return listReads === 1 ? new Promise<Response>((resolve) => (releaseStaleRead = resolve)) : json(before)
      }
      if (url === `${CONTROL}${ControlPaths.activeBox}` && method === "PUT") return json(after)
      return undefined
    })

    const stale = api.boxes()
    await tick()
    await api.setActiveBox(BOX_ID)
    releaseStaleRead(json(before))

    expect((await stale).activeBoxId).toBe(BOX_ID)
  })
})

describe("thread reads across the user's boxes", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("a box that never answers does not hold a healthy box back", async () => {
    const healthy = entryFor("healthy-box", "https://healthy.test")
    const stalled = entryFor("stalled-box", "https://stalled.test")
    let releaseStalled: (response: Response) => void = () => {}
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [healthy, stalled], activeBoxId: healthy.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(healthy.id)}`) return tokenFor(healthy.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(stalled.id)}`) return tokenFor(stalled.url)
      if (url === `${healthy.url}${Paths.tasks}`) return json([taskFor("healthy-thread")])
      if (url === `${stalled.url}${Paths.tasks}`) return new Promise<Response>((resolve) => (releaseStalled = resolve))
      return undefined
    })

    const tasks = await Promise.race([
      api.listTasks().then((list) => list.map((t) => t.id)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("held by the stalled box")), 4_000)),
    ])
    releaseStalled(new Response("{}", { status: 500 }))
    await settle()

    expect(tasks).toEqual(["healthy-thread"])
  })

  test("a slow box is listed by the next read, and is not asked again while its first read is pending", async () => {
    const healthy = entryFor("healthy-box-3", "https://healthy-3.test")
    const slow = entryFor("slow-box-3", "https://slow-3.test")
    let answerSlow: (response: Response) => void = () => {}
    let slowAnswered = false
    let slowAsks = 0
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [healthy, slow], activeBoxId: healthy.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(healthy.id)}`) return tokenFor(healthy.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(slow.id)}`) return tokenFor(slow.url)
      if (url === `${healthy.url}${Paths.tasks}`) return json([taskFor("healthy-thread-3")])
      if (url === `${slow.url}${Paths.tasks}`) {
        if (slowAnswered) return json([taskFor("slow-thread")])
        slowAsks += 1
        return new Promise<Response>((resolve) => (answerSlow = resolve))
      }
      return undefined
    })

    const first = (await api.listTasks()).map((t) => t.id)
    const second = (await api.listTasks()).map((t) => t.id)
    expect(first).toEqual(["healthy-thread-3"])
    expect(second).toEqual(["healthy-thread-3"])
    expect(slowAsks).toBe(1)

    slowAnswered = true
    answerSlow(json([taskFor("slow-thread")]))
    await settle()
    const third = (await api.listTasks()).map((t) => t.id).sort()
    expect(third).toEqual(["healthy-thread-3", "slow-thread"])
  })

  test("a box that stops answering keeps its last threads, and its threads still route to it", async () => {
    const healthy = entryFor("healthy-box-4", "https://healthy-4.test")
    const flaky = entryFor("flaky-box", "https://flaky.test")
    let flakyFails = false
    const deletes: string[] = []
    routes((url, method) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [healthy, flaky], activeBoxId: healthy.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(healthy.id)}`) return tokenFor(healthy.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(flaky.id)}`) return tokenFor(flaky.url)
      if (url === `${healthy.url}${Paths.tasks}`) return json([taskFor("healthy-thread-4")])
      if (url === `${flaky.url}${Paths.tasks}`) {
        return flakyFails ? new Response("{}", { status: 500 }) : json([taskFor("flaky-keep-thread")])
      }
      if (url === `${flaky.url}${Paths.task("flaky-keep-thread")}` && method === "DELETE") {
        deletes.push(url)
        return json({})
      }
      return undefined
    })

    expect((await api.listTasks()).map((t) => t.id).sort()).toEqual(["flaky-keep-thread", "healthy-thread-4"])
    flakyFails = true
    expect((await api.listTasks()).map((t) => t.id).sort()).toEqual(["flaky-keep-thread", "healthy-thread-4"])

    await api.deleteTask("flaky-keep-thread")
    expect(deletes).toEqual([`${flaky.url}${Paths.task("flaky-keep-thread")}`])
  })

  test("a removed box's threads are not shown", async () => {
    const removed = entryFor("removed-box", "https://removed.test")
    let current = { boxes: [BYOB_ENTRY, removed], activeBoxId: BOX_ID }
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json(current)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) return tokenFor(BOX)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(removed.id)}`) return tokenFor(removed.url)
      if (url === `${BOX}${Paths.tasks}`) return json([taskFor("user-thread")])
      if (url === `${removed.url}${Paths.tasks}`) return json([taskFor("removed-thread")])
      return undefined
    })
    expect((await api.listTasks()).map((t) => t.id).sort()).toEqual(["removed-thread", "user-thread"])

    current = { ...current, boxes: [BYOB_ENTRY] }

    expect((await api.listTasks()).map((t) => t.id)).toEqual(["user-thread"])
  })

  test("a thread whose box left the list reads as gone, not merely not found", async () => {
    const removed = entryFor("removed-box-2", "https://removed-2.test")
    let current = { boxes: [BYOB_ENTRY, removed], activeBoxId: BOX_ID }
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json(current)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) return tokenFor(BOX)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(removed.id)}`) return tokenFor(removed.url)
      if (url === `${BOX}${Paths.tasks}`) return json([taskFor("user-thread-2")])
      if (url === `${removed.url}${Paths.tasks}`) return json([taskFor("removed-thread-2")])
      return undefined
    })
    await api.listTasks()

    current = { ...current, boxes: [BYOB_ENTRY] }
    await api.listTasks()

    await expect(api.getTask("removed-thread-2")).rejects.toThrow("The box this thread lived on is gone")
    await expect(api.getTask("never-seen")).rejects.toThrow("Thread not found")
  })

  test("a box that answers after another is listed by that same read", async () => {
    const healthy = entryFor("healthy-box-5", "https://healthy-5.test")
    const late = entryFor("late-box", "https://late.test")
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [healthy, late], activeBoxId: healthy.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(healthy.id)}`) return tokenFor(healthy.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(late.id)}`) return tokenFor(late.url)
      if (url === `${healthy.url}${Paths.tasks}`) return json([taskFor("user-thread")])
      if (url === `${late.url}${Paths.tasks}`) {
        return new Promise<Response>((resolve) => setTimeout(() => resolve(json([taskFor("late-thread")])), 300))
      }
      return undefined
    })

    expect((await api.listTasks()).map((t) => t.id).sort()).toEqual(["late-thread", "user-thread"])
  })

  test("a box that fails at once does not hold back another box's cached threads", async () => {
    const cached = entryFor("cached-box", "https://cached.test")
    const failing = entryFor("failing-box", "https://failing.test")
    let userHangs = false
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [cached, failing], activeBoxId: cached.id })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(cached.id)}`) return tokenFor(cached.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(failing.id)}`) return tokenFor(failing.url)
      if (url === `${cached.url}${Paths.tasks}`) {
        return userHangs ? new Promise<Response>(() => {}) : json([taskFor("cached-user-thread")])
      }
      if (url === `${failing.url}${Paths.tasks}`) return json({ _tag: "Unavailable", message: "down" }, 503)
      return undefined
    })
    expect((await api.listTasks()).map((t) => t.id)).toEqual(["cached-user-thread"])

    userHangs = true
    const started = Date.now()
    expect((await api.listTasks()).map((t) => t.id)).toEqual(["cached-user-thread"])
    // Within the grace period after the failing box's failure, not the user box's full wait.
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)

  test("an answering box is waited for when the other fails", async () => {
    const failing = entryFor("failing-box", "https://failing.test")
    const answering = entryFor("answering-box", "https://answering.test")
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [failing, answering], activeBoxId: null })
      if (url === `${CONTROL}${ControlPaths.userBoxToken(failing.id)}`) return tokenFor(failing.url)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(answering.id)}`) return tokenFor(answering.url)
      if (url === `${failing.url}${Paths.tasks}`) return new Response("{}", { status: 500 })
      if (url === `${answering.url}${Paths.tasks}`) return json([taskFor("answering-thread")])
      return undefined
    })

    expect((await api.listTasks()).map((t) => t.id)).toEqual(["answering-thread"])
  })

  test("a user with no boxes gets an empty list", async () => {
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [], activeBoxId: null })
      return undefined
    })
    expect((await api.listTasks()).map((t) => t.id)).toEqual([])
  })
})

/** A user box with one thread, whose box tokens are minted by `mint`; records the Authorization each box call sent. */
function tokenBox(id: string, mint: (call: number) => Response) {
  const box = entryFor(id, `https://${id}.test`)
  const authorizations: string[] = []
  let mints = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === `${CONTROL}${ControlPaths.boxes}`) return json({ boxes: [box], activeBoxId: box.id })
    if (url === `${CONTROL}${ControlPaths.userBoxToken(box.id)}`) {
      mints += 1
      return mint(mints)
    }
    if (url === `${box.url}${Paths.tasks}`) {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      return json([taskFor("cached-thread")])
    }
    throw new Error(`unexpected request ${url}`)
  }) as typeof fetch
  return { authorizations }
}

describe("box tokens when control cannot mint a fresh one", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("a token still before its expiry is used when control is down and cannot mint a fresh one", async () => {
    // The token expires in 30 s, so it is already past its refresh time and the next read must mint.
    const { authorizations } = tokenBox("token-outage", (call) =>
      call === 1
        ? json({ token: "t-first", url: "https://token-outage.test", expiresAt: new Date(Date.now() + 30_000).toISOString() })
        : new Response("{}", { status: 503 }),
    )

    expect((await api.listTasks()).map((t) => t.id)).toEqual(["cached-thread"])
    expect((await api.listTasks()).map((t) => t.id)).toEqual(["cached-thread"])
    expect(authorizations).toEqual(["Bearer t-first", "Bearer t-first"])
  })

  test("a refused mint is not papered over with the cached token", async () => {
    const { authorizations } = tokenBox("token-refused", (call) =>
      call === 1
        ? json({ token: "t-refused-1", url: "https://token-refused.test", expiresAt: new Date(Date.now() + 30_000).toISOString() })
        : new Response("{}", { status: 401 }),
    )

    expect((await api.listTasks()).map((t) => t.id)).toEqual(["cached-thread"])
    await expect(api.listTasks()).rejects.toBeDefined()
    expect(authorizations).toEqual(["Bearer t-refused-1"])
  })
})

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
  managedBox: null,
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
    // Kestrel's own box is reached through the control plane's relay; it fails at once here.
    if (url.startsWith(`${CONTROL}/api/`) && init?.method !== "POST") throw new TypeError("relay down")
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

  test("a box that waits out its 15 s control timeout before answering offline is still listed", async () => {
    // The box's offline fallback answers after its own 15 s control wait; the list must wait for that answer.
    stubFetch({
      box: () => new Promise<Response>((resolve) => setTimeout(() => resolve(json([task])), 15_500)),
    })
    const tasks = await api.listTasks()
    expect(tasks.map((t) => t.id)).toEqual(["thread-1"])
  }, 40_000)
})

const MANAGED_ID = "managed-1"
const MANAGED = "https://managed.test"
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

/** Lets a request that was just started reach the fetch stub. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("box list reads that answer after a change", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("a read that answers after a box switch does not undo the switch", async () => {
    const before = { boxes: [BYOB_ENTRY], activeBoxId: null, managedBox: null }
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
    // The active-box call goes to the switched box, not to the relay the stale list named.
    expect(boxCalls).toEqual([`${BOX}${ControlPaths.cliLoginCancel("claude-cli")}`])
  })
})

describe("a user's own boxes and Kestrel's managed box", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const managedList = {
    boxes: [BYOB_ENTRY],
    activeBoxId: BOX_ID,
    managedBox: { id: MANAGED_ID, url: MANAGED },
  }

  test("a managed box that never answers does not hold a user's own box back", async () => {
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json(managedList)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) return tokenFor(BOX)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(MANAGED_ID)}`) return tokenFor(MANAGED)
      if (url === `${BOX}${Paths.tasks}`) return json([task])
      if (url === `${MANAGED}${Paths.tasks}`) return new Promise<Response>(() => {})
      return undefined
    })

    const tasks = await Promise.race([
      api.listTasks().then((list) => list.map((t) => t.id)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("held by the managed box")), 2_000)),
    ])

    expect(tasks).toEqual(["thread-1"])
  })

  test("the managed box is waited for when no user box answers", async () => {
    const managedTask = { ...task, id: "managed-thread" }
    routes((url) => {
      if (url === `${CONTROL}${ControlPaths.boxes}`) return json(managedList)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(BOX_ID)}`) return tokenFor(BOX)
      if (url === `${CONTROL}${ControlPaths.userBoxToken(MANAGED_ID)}`) return tokenFor(MANAGED)
      if (url === `${BOX}${Paths.tasks}`) return new Response("{}", { status: 500 })
      if (url === `${MANAGED}${Paths.tasks}`) return json([managedTask])
      return undefined
    })

    const tasks = await api.listTasks()

    expect(tasks.map((t) => t.id)).toEqual(["managed-thread"])
  })
})

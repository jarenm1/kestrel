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

import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_GUEST_FRAME_BYTES, type BoxActivity, type BoxToGuest, type GpuState } from "@cloudagents/protocol"
import { startGuestLink, type GuestHandlers, type GuestLinkOptions } from "./guest-link"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const idle: BoxActivity = { runs: 0, desktops: 0, viewers: 0, recordings: 0, lastActivityAt: null }

type Received = { readonly conn: number; readonly frame: BoxToGuest }

/**
 * A guest agent on a real unix socket. It records what the box sends, per connection, and wakes the waiters on every
 * frame, connection and `wake()`, so tests wait for the event they expect instead of a guessed duration.
 */
const fakeGuest = async () => {
  const dir = await mkdtemp(join(tmpdir(), "guest-link-test-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "box.sock")
  const sockets: Socket[] = []
  const received: Received[] = []
  const waiters = new Set<() => void>()
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter()
  }
  const server = createServer((socket) => {
    const conn = sockets.length
    sockets.push(socket)
    socket.on("error", () => {})
    wake()
    let buffered = ""
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8")
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line !== "") received.push({ conn, frame: JSON.parse(line) as BoxToGuest })
        wake()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  return {
    received,
    connections: () => sockets.length,
    path,
    wake,
    /** Resolves once `check` holds; re-checked on every event. Bun's test timeout bounds a wait that never completes. */
    when: (check: () => boolean): Promise<void> =>
      new Promise<void>((resolve) => {
        if (check()) return resolve()
        const waiter = () => {
          if (!check()) return
          waiters.delete(waiter)
          resolve()
        }
        waiters.add(waiter)
      }),
    send: (frame: unknown) => sockets.at(-1)?.write(`${JSON.stringify(frame)}\n`),
    sendLine: (line: string) => sockets.at(-1)?.write(`${line}\n`),
    dropLatest: () => sockets.at(-1)?.destroy(),
  }
}

type Guest = Awaited<ReturnType<typeof fakeGuest>>

const noopHandlers: GuestHandlers = {
  quiesce: async () => {},
  resumed: async () => {},
  releaseGpu: async () => {},
  gpuState: async () => {},
}

const startLink = (guest: Guest, overrides: Partial<Omit<GuestLinkOptions, "socketPath">> = {}) => {
  const warnings: string[] = []
  const link = startGuestLink({
    socketPath: guest.path,
    boxVersion: "test-1",
    activity: () => idle,
    handlers: noopHandlers,
    warn: (message) => warnings.push(message),
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    pollMs: 10,
    heartbeatMs: 60_000,
    ...overrides,
  })
  cleanups.push(() => link.close())
  return { link, warnings }
}

const repliesTo = (guest: Guest, id: string): BoxToGuest[] =>
  guest.received.map((r) => r.frame).filter((frame) => frame._tag === "reply" && frame.id === id)

const activitiesWithRuns = (guest: Guest, runs: number): number =>
  guest.received.filter((r) => r.frame._tag === "activity" && r.frame.activity.runs === runs).length

const wishIds = (guest: Guest): string[] =>
  guest.received.flatMap((r) => (r.frame._tag === "gpuWanted" ? [r.frame.id] : []))

describe("guest link", () => {
  test("hello and the activity come first on connect; the GPU wish follows once it holds", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)

    await guest.when(() => guest.received.length >= 2)
    expect(guest.received[0]?.frame).toEqual({ _tag: "hello", boxVersion: "test-1" })
    expect(guest.received[1]?.frame._tag).toBe("activity")

    link.setWanted(true)
    await guest.when(() => guest.received.some((r) => r.frame._tag === "gpuWanted"))
    expect(guest.received.find((r) => r.frame._tag === "gpuWanted")?.frame).toEqual({
      _tag: "gpuWanted",
      id: expect.any(String),
      wanted: true,
    })
  })

  test("a changed activity is sent by the poll; an unchanged one waits for the heartbeat or a forced send", async () => {
    const guest = await fakeGuest()
    let current = idle
    let polls = 0
    const { link } = startLink(guest, {
      activity: () => {
        polls++
        guest.wake()
        return current
      },
    })
    await guest.when(() => guest.received.some((r) => r.frame._tag === "activity"))

    current = { ...idle, runs: 1 }
    await guest.when(() => activitiesWithRuns(guest, 1) === 1)

    const basePolls = polls
    await guest.when(() => polls >= basePolls + 5)
    guest.send({ _tag: "quiesce", id: "hb" })
    await guest.when(() => repliesTo(guest, "hb").length === 1)
    expect(activitiesWithRuns(guest, 1)).toBe(1)

    link.sendActivityNow()
    await guest.when(() => activitiesWithRuns(guest, 1) === 2)
  })

  test("quiesce, resumed and releaseGpu are answered ok, or with the handler's error", async () => {
    const guest = await fakeGuest()
    startLink(guest, {
      handlers: {
        ...noopHandlers,
        resumed: async () => {
          throw new Error("resume broke")
        },
      },
    })
    await guest.when(() => guest.received.length >= 2)

    guest.send({ _tag: "quiesce", id: "q1" })
    guest.send({ _tag: "resumed", id: "r1" })
    guest.send({ _tag: "releaseGpu", id: "g1" })
    await guest.when(() => repliesTo(guest, "g1").length === 1)

    expect(repliesTo(guest, "q1")).toEqual([{ _tag: "reply", id: "q1", ok: true }])
    expect(repliesTo(guest, "r1")).toEqual([{ _tag: "reply", id: "r1", ok: false, error: "resume broke" }])
    expect(repliesTo(guest, "g1")).toEqual([{ _tag: "reply", id: "g1", ok: true }])
  })

  test("gpuState reaches its handler and is not answered; a rejected gpuState is warned and the link carries on", async () => {
    const guest = await fakeGuest()
    const states: Array<readonly [GpuState, string | null]> = []
    const { warnings } = startLink(guest, {
      handlers: {
        ...noopHandlers,
        gpuState: async (state, pciAddress) => {
          states.push([state, pciAddress])
          if (state === "detaching") throw new Error("pci device vanished")
        },
      },
    })
    await guest.when(() => guest.received.length >= 2)

    guest.send({ _tag: "gpuState", state: "attached", pciAddress: "0000:00:02.0" })
    guest.send({ _tag: "gpuState", state: "detaching", pciAddress: null })
    guest.send({ _tag: "quiesce", id: "q2" })
    await guest.when(() => repliesTo(guest, "q2").length === 1)

    expect(states).toEqual([
      ["attached", "0000:00:02.0"],
      ["detaching", null],
    ])
    expect(guest.received.filter((r) => r.frame._tag === "reply")).toHaveLength(1)
    expect(warnings.some((message) => message.includes("pci device vanished"))).toBe(true)
  })

  test("unknown frames and lines that do not decode are ignored", async () => {
    const guest = await fakeGuest()
    startLink(guest)
    await guest.when(() => guest.received.length >= 2)

    guest.send({ _tag: "from-a-newer-guest", extra: true })
    guest.sendLine("not json at all")
    guest.send({ _tag: "quiesce", id: "q3" })
    await guest.when(() => repliesTo(guest, "q3").length === 1)
    expect(repliesTo(guest, "q3")).toEqual([{ _tag: "reply", id: "q3", ok: true }])
  })

  test("a frame over the limit closes the link; the box reconnects and says hello again", async () => {
    const guest = await fakeGuest()
    const { warnings } = startLink(guest)
    await guest.when(() => guest.connections() === 1)

    guest.sendLine("x".repeat(MAX_GUEST_FRAME_BYTES + 1))
    await guest.when(() => guest.connections() === 2)
    await guest.when(() => guest.received.some((r) => r.conn === 1 && r.frame._tag === "hello"))

    expect(warnings.some((message) => message.includes("frame limit"))).toBe(true)
  })

  test("the GPU wish is sent again on every reconnect while it holds, under the same id", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)
    link.setWanted(true)
    await guest.when(() => guest.received.some((r) => r.conn === 0 && r.frame._tag === "gpuWanted"))

    guest.dropLatest()
    await guest.when(() => guest.connections() === 2)
    await guest.when(() => guest.received.some((r) => r.conn === 1 && r.frame._tag === "gpuWanted"))
    const sent = guest.received.filter((r) => r.frame._tag === "gpuWanted").map((r) => r.frame)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  test("a wish resolves on the guest's ok reply and rejects on its refusal", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)

    const granted = link.setWanted(true)
    await guest.when(() => wishIds(guest).length === 1)
    guest.send({ _tag: "reply", id: wishIds(guest)[0], ok: true })
    await expect(granted).resolves.toBeUndefined()

    const refused = link.setWanted(true)
    await guest.when(() => wishIds(guest).length === 2)
    guest.send({ _tag: "reply", id: wishIds(guest)[1], ok: false, error: "no GPU on this host" })
    await expect(refused).rejects.toThrow("no GPU on this host")
  })

  test("a request made while disconnected settles the earlier request for the same state", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    const first = link.setWanted(true)
    const second = link.setWanted(true)
    await guest.when(() => guest.connections() === 1)
    await guest.when(() => wishIds(guest).length === 1)
    guest.send({ _tag: "reply", id: wishIds(guest)[0], ok: true })
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  test("a request superseded by a release before it attached is refused", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)
    const requested = link.setWanted(true)
    link.setWanted(false)
    await expect(requested).rejects.toThrow("the GPU was released before it attached")
  })

  test("a release made while disconnected reaches the guest on reconnect", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)
    link.setWanted(true)
    await guest.when(() => guest.received.some((r) => r.conn === 0 && r.frame._tag === "gpuWanted"))

    guest.dropLatest()
    link.setWanted(false)
    await guest.when(() => guest.connections() === 2)
    await guest.when(() => guest.received.some((r) => r.conn === 1 && r.frame._tag === "gpuWanted"))
    expect(guest.received.find((r) => r.conn === 1 && r.frame._tag === "gpuWanted")?.frame).toEqual({
      _tag: "gpuWanted",
      id: expect.any(String),
      wanted: false,
    })
  })

  test("enrollment is announced on connect and again on every reconnect", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)
    link.markEnrolled()
    await guest.when(() => guest.received.some((r) => r.conn === 0 && r.frame._tag === "enrolled"))

    guest.dropLatest()
    await guest.when(() => guest.connections() === 2)
    await guest.when(() => guest.received.some((r) => r.conn === 1 && r.frame._tag === "enrolled"))
  })

  test("closing the link rejects a wish the guest has not answered", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)
    const pending = link.setWanted(true)
    link.close()
    await expect(pending).rejects.toThrow("the box is stopping")
  })

  test("close stops the link: nothing reconnects afterwards", async () => {
    const guest = await fakeGuest()
    const { link } = startLink(guest)
    await guest.when(() => guest.connections() === 1)

    link.close()
    guest.dropLatest()
    // Real-time exception: "no reconnect happens" has no event to wait on. The reconnect delay here is 10 ms, so
    // 80 ms covers several would-be attempts.
    await Bun.sleep(80)
    expect(guest.connections()).toBe(1)
  })
})

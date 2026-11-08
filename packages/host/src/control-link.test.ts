import { afterEach, describe, expect, test } from "bun:test"
import { NEST_LAPSE_REFUSAL } from "@cloudagents/protocol"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { WebSocketServer, type WebSocket } from "ws"
import { ControlLink } from "./control-link"
import { destroyCommand, newTestManager, resumeCommand, type TestManager } from "./vm-manager.fixture"
import type { ExecutedCommand, VmManager } from "./vm-manager"

/** A host connection seen from the control plane: the frames the host sent, and a way to send frames back. */
interface Peer {
  readonly socket: WebSocket
  readonly frames: Record<string, unknown>[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const run of cleanup.splice(0)) run()
})

/**
 * A loopback control plane and a ControlLink dialing it with `manager`. `executed` lists every command id the link has
 * handed to `manager.execute`, in order, so a test waits for the host to have queued a command rather than sleeping.
 */
const connect = async (manager: VmManager) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  cleanup.push(() => server.close())
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const port = (server.address() as { port: number }).port
  const peers: Peer[] = []
  server.on("connection", (socket) => {
    const peer: Peer = { socket, frames: [] }
    socket.on("message", (data) => peer.frames.push(JSON.parse(data.toString())))
    peers.push(peer)
  })
  const executed: string[] = []
  const execute = manager.execute.bind(manager)
  manager.execute = (commandId, command) => {
    executed.push(commandId)
    return execute(commandId, command)
  }
  const leaseCalls: number[] = []
  const setLease = manager.setLease.bind(manager)
  manager.setLease = (validUntil) => {
    leaseCalls.push(validUntil)
    return setLease(validUntil)
  }
  const link = new ControlLink({
    controlUrl: `ws://127.0.0.1:${port}`,
    hostId: "host-1",
    secret: "secret",
    slug: "host-1",
    agentVersion: "test",
    imageId: "image-1",
    manager,
    log: () => {},
  })
  link.start()
  cleanup.push(() => link.stop())
  await waitFor(() => peers.length === 1 && hasFrame(peers[0] as Peer, "hello"), "hello")
  return { peers, peer: peers[0] as Peer, executed, leaseCalls }
}

const hasFrame = (peer: Peer, tag: string): boolean => peer.frames.some((frame) => frame._tag === tag)

const sendCommand = (peer: Peer, commandId: string, command: unknown) =>
  peer.socket.send(JSON.stringify({ _tag: "command", commandId, command }))

const sendLease = (peer: Peer, validUntil: number) => peer.socket.send(JSON.stringify({ _tag: "lease", validUntil }))

const resultsFor = (peer: Peer, commandId: string) =>
  peer.frames.filter((frame) => frame._tag === "result" && frame.commandId === commandId)

const resultFor = (peer: Peer, commandId: string) => resultsFor(peer, commandId)[0]

/** A manager stand-in for tests that only need the link's own behavior. */
const fakeManager = (overrides: Partial<Record<keyof VmManager, unknown>>): VmManager =>
  ({
    capacity: () => ({}),
    reports: () => [],
    pendingResults: () => [],
    markReported: () => {},
    setLease: () => {},
    connectionLost: () => {},
    ...overrides,
  }) as unknown as VmManager

describe("control link with a fake manager", () => {
  test("a drop invalidates the connection, and a command refused after the drop sends no result", async () => {
    let release!: (value: ExecutedCommand | null) => void
    let drops = 0
    const leases: number[] = []
    const manager = fakeManager({
      setLease: (validUntil: number) => leases.push(validUntil),
      connectionLost: () => {
        drops += 1
      },
      execute: () =>
        new Promise<ExecutedCommand | null>((resolve) => {
          release = resolve
        }),
    })
    const { peers, peer, executed } = await connect(manager)
    sendCommand(peer, "cmd-1", destroyCommand(1))
    await waitFor(() => executed.includes("cmd-1"), "cmd-1 to be queued")

    peer.socket.close()
    await waitFor(() => drops === 1, "connectionLost on drop")
    await waitFor(() => peers.length === 2 && hasFrame(peers[1] as Peer, "hello"), "second hello")
    sendLease(peers[1] as Peer, Date.now() + 60_000)
    await waitFor(() => leases.length === 1, "lease on reconnect")

    release(null)
    await sleep(50)
    expect(resultsFor(peer, "cmd-1")).toHaveLength(0)
    expect(resultsFor(peers[1] as Peer, "cmd-1")).toHaveLength(0)
  })

  test("a command that ran reports its result on the live socket", async () => {
    const manager = fakeManager({
      execute: async (commandId: string) => ({
        outcome: { commandId, boxId: "box-1", ok: true, reported: false },
        vm: null,
      }),
    })
    const { peer } = await connect(manager)
    sendCommand(peer, "cmd-2", destroyCommand(1))
    await waitFor(() => resultFor(peer, "cmd-2") !== undefined, "result frame")
    expect(resultFor(peer, "cmd-2")).toMatchObject({ ok: true })
  })
})

describe("control link with the real manager", () => {
  test("a lapse on a live socket answers the queued command with a failure, so the control plane is not left waiting", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.manager.setLease(Date.now() + 60_000)
    const { peer, executed } = await connect(fixture.manager)

    sendCommand(peer, "cmd-busy", destroyCommand(1))
    await fixture.started
    sendCommand(peer, "cmd-stale", resumeCommand(1))
    await waitFor(() => executed.includes("cmd-stale"), "cmd-stale to be queued")

    // The lease lapses while the socket stays up; the control plane's next lease frame renews it.
    fixture.manager.setLease(Date.now() - 1)
    sendLease(peer, Date.now() + 60_000)
    fixture.open()

    await waitFor(() => resultFor(peer, "cmd-stale") !== undefined, "failure result for the refused command")
    expect(resultFor(peer, "cmd-stale")).toMatchObject({ ok: false, error: NEST_LAPSE_REFUSAL })
    expect(resultFor(peer, "cmd-busy")).toMatchObject({ ok: true })
    expect(fixture.applied).toEqual(["destroy"])
    expect(fixture.manager.pendingResults().map((outcome) => outcome.commandId)).toEqual([])
  })

  test("a lease frame whose write fails does not take the link down, and later frames still apply", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.open()
    fixture.manager.setLease(Date.now() + 60_000)
    const { peer, executed, leaseCalls } = await connect(fixture.manager)

    rmSync(fixture.leasePath)
    mkdirSync(fixture.leasePath)
    const renewal = Date.now() + 60_000
    sendLease(peer, renewal)
    await waitFor(() => leaseCalls.includes(renewal), "the failed renewal to reach the manager")

    rmSync(fixture.leasePath, { recursive: true })
    sendCommand(peer, "cmd-after", destroyCommand(1))
    await waitFor(() => resultFor(peer, "cmd-after") !== undefined, "a result after the failed renewal")
    expect(resultFor(peer, "cmd-after")).toMatchObject({ ok: true })
    expect(executed).toContain("cmd-after")
  })

  test("a command whose outcome cannot be stored still answers, and its resend is not run again", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.open()
    fixture.manager.setLease(Date.now() + 60_000)
    const { peer } = await connect(fixture.manager)

    chmodSync(fixture.stateDir, 0o500)
    sendCommand(peer, "cmd-unstored", destroyCommand(1))
    await waitFor(() => resultFor(peer, "cmd-unstored") !== undefined, "the result of the unstored command")
    chmodSync(fixture.stateDir, 0o700)

    // The control plane never saw the result and resends the command on the same connection.
    sendCommand(peer, "cmd-unstored", destroyCommand(1))
    await waitFor(() => resultsFor(peer, "cmd-unstored").length === 2, "the answer to the resend")
    expect(resultsFor(peer, "cmd-unstored").map((frame) => frame.ok)).toEqual([true, true])
    expect(fixture.applied).toEqual(["destroy"])
  })

  test("after a lapse and reconnect, a resend that arrives behind the renewed lease runs", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.manager.setLease(Date.now() + 60_000)
    const { peers, peer } = await connect(fixture.manager)

    // The lease lapses while the link is down; control's hello renews it before it resends.
    fixture.manager.setLease(Date.now() - 1)
    peer.socket.close()
    await waitFor(() => peers.length === 2 && hasFrame(peers[1] as Peer, "hello"), "second hello")
    sendLease(peers[1] as Peer, Date.now() + 60_000)
    sendCommand(peers[1] as Peer, "cmd-resend", resumeCommand(1))
    await waitFor(() => resultFor(peers[1] as Peer, "cmd-resend") !== undefined, "the resend's result")
    expect(resultFor(peers[1] as Peer, "cmd-resend")).toMatchObject({ ok: true })
    expect(fixture.applied).toEqual(["resume"])
  })

  test("after a lapse and reconnect, a resend that arrives ahead of the renewal is refused with a failure", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.manager.setLease(Date.now() + 60_000)
    const { peers, peer } = await connect(fixture.manager)

    fixture.manager.setLease(Date.now() - 1)
    peer.socket.close()
    await waitFor(() => peers.length === 2 && hasFrame(peers[1] as Peer, "hello"), "second hello")
    sendCommand(peers[1] as Peer, "cmd-resend", resumeCommand(1))
    await waitFor(() => resultFor(peers[1] as Peer, "cmd-resend") !== undefined, "the refusal's result")
    expect(resultFor(peers[1] as Peer, "cmd-resend")).toMatchObject({ ok: false })
    expect(fixture.applied).toEqual([])
  })

  test("a command resent after reconnect, once its result was reported, is answered from the store and does not run again", async () => {
    const fixture: TestManager = newTestManager()
    cleanup.push(fixture.dispose)
    fixture.open()
    fixture.manager.setLease(Date.now() + 60_000)
    const { peers, peer, executed } = await connect(fixture.manager)

    sendCommand(peer, "cmd-once", destroyCommand(1))
    await waitFor(() => resultFor(peer, "cmd-once") !== undefined, "first result")

    // The link drops and comes back; the control plane, having lost track of the result, resends the command.
    peer.socket.close()
    await waitFor(() => peers.length === 2 && hasFrame(peers[1] as Peer, "hello"), "second hello")
    sendLease(peers[1] as Peer, Date.now() + 60_000)
    sendCommand(peers[1] as Peer, "cmd-once", destroyCommand(1))
    await waitFor(() => resultFor(peers[1] as Peer, "cmd-once") !== undefined, "late duplicate result")

    expect(executed.filter((id) => id === "cmd-once")).toHaveLength(2)
    expect(resultFor(peers[1] as Peer, "cmd-once")).toEqual(resultFor(peer, "cmd-once"))
    expect(fixture.applied).toEqual(["destroy"])
  })
})

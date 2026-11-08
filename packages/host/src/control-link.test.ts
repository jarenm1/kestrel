import { afterEach, describe, expect, test } from "bun:test"
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

/** A loopback control plane and a ControlLink dialing it with `manager`. */
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
  return { peers, peer: peers[0] as Peer }
}

const hasFrame = (peer: Peer, tag: string): boolean => peer.frames.some((frame) => frame._tag === tag)

const sendCommand = (peer: Peer, commandId: string, command: unknown) =>
  peer.socket.send(JSON.stringify({ _tag: "command", commandId, command }))

const resultFor = (peer: Peer, commandId: string) =>
  peer.frames.find((frame) => frame._tag === "result" && frame.commandId === commandId)

describe("control link with a fake manager", () => {
  test("a drop invalidates queued commands, and a command refused after the drop sends no result", async () => {
    let release!: (value: ExecutedCommand | null) => void
    let drops = 0
    const leases: number[] = []
    const fake = {
      capacity: () => ({}),
      reports: () => [],
      pendingResults: () => [],
      markReported: () => {},
      setLease: (validUntil: number) => leases.push(validUntil),
      connectionLost: () => {
        drops += 1
      },
      execute: () =>
        new Promise<ExecutedCommand | null>((resolve) => {
          release = resolve
        }),
    } as unknown as VmManager
    const { peers, peer } = await connect(fake)
    sendCommand(peer, "cmd-1", destroyCommand(1))
    await sleep(20)

    peer.socket.close()
    await waitFor(() => drops === 1, "connectionLost on drop")
    await waitFor(() => peers.length === 2 && hasFrame(peers[1] as Peer, "hello"), "second hello")
    ;(peers[1] as Peer).socket.send(JSON.stringify({ _tag: "lease", validUntil: Date.now() + 60_000 }))
    await waitFor(() => leases.length === 1, "lease on reconnect")

    release(null)
    await sleep(50)
    expect(resultFor(peer, "cmd-1")).toBeUndefined()
    expect(resultFor(peers[1] as Peer, "cmd-1")).toBeUndefined()
  })

  test("a command that ran reports its result on the live socket", async () => {
    const fake = {
      capacity: () => ({}),
      reports: () => [],
      pendingResults: () => [],
      markReported: () => {},
      setLease: () => {},
      connectionLost: () => {},
      execute: async (commandId: string) => ({
        outcome: { commandId, boxId: "box-1", ok: true, reported: false },
        vm: null,
      }),
    } as unknown as VmManager
    const { peer } = await connect(fake)
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
    const { peer } = await connect(fixture.manager)

    sendCommand(peer, "cmd-busy", destroyCommand(1))
    await fixture.started
    sendCommand(peer, "cmd-stale", resumeCommand(1))
    await sleep(20)

    // The lease lapses while the socket stays up; the control plane's next lease frame renews it.
    fixture.manager.setLease(Date.now() - 1)
    peer.socket.send(JSON.stringify({ _tag: "lease", validUntil: Date.now() + 60_000 }))
    await sleep(20)
    fixture.open()

    await waitFor(() => resultFor(peer, "cmd-stale") !== undefined, "failure result for the refused command")
    expect(resultFor(peer, "cmd-stale")).toMatchObject({ ok: false, error: "control lease lapsed before the command ran" })
    expect(resultFor(peer, "cmd-busy")).toMatchObject({ ok: true })
    expect(fixture.applied).toEqual(["destroy"])
    expect(fixture.manager.pendingResults().map((outcome) => outcome.commandId)).toEqual([])
  })
})

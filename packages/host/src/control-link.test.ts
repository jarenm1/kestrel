import { afterEach, describe, expect, test } from "bun:test"
import { WebSocketServer, type WebSocket } from "ws"
import { ControlLink } from "./control-link"
import type { ExecutedCommand, VmManager } from "./vm-manager"

/** A control plane on loopback: records each connection's frames from the host and can send frames to it. */
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

const destroy = { _tag: "destroy", boxId: "box-1", ownerEpoch: 1 }

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const run of cleanup.splice(0)) run()
})

const setup = async (execute: (commandId: string) => Promise<ExecutedCommand | null>) => {
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

  const invalidations: number[] = []
  const leases: number[] = []
  const manager = {
    capacity: () => ({}),
    reports: () => [],
    pendingResults: () => [],
    markReported: () => {},
    setLease: (validUntil: number) => leases.push(validUntil),
    invalidateQueuedCommands: () => invalidations.push(invalidations.length + 1),
    execute: (commandId: string) => execute(commandId),
  } as unknown as VmManager
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
  return { peers, invalidations, leases }
}

const resultFramesFor = (peer: Peer, commandId: string) =>
  peer.frames.filter((frame) => frame._tag === "result" && frame.commandId === commandId)

describe("control link and refused commands", () => {
  test("a command refused after the socket dropped sends no result, and the drop invalidates queued commands", async () => {
    let release!: (value: ExecutedCommand | null) => void
    const { peers, invalidations, leases } = await setup(
      () =>
        new Promise<ExecutedCommand | null>((resolve) => {
          release = resolve
        }),
    )
    await waitFor(() => peers.length === 1 && peers[0]?.frames.some((frame) => frame._tag === "hello") === true, "first hello")
    peers[0]?.socket.send(JSON.stringify({ _tag: "command", commandId: "cmd-1", command: destroy }))
    await sleep(20)

    peers[0]?.socket.close()
    await waitFor(() => invalidations.length === 1, "invalidation on drop")
    await waitFor(() => peers.length === 2 && peers[1]?.frames.some((frame) => frame._tag === "hello") === true, "second hello")
    peers[1]?.socket.send(JSON.stringify({ _tag: "lease", validUntil: Date.now() + 60_000 }))
    await waitFor(() => leases.length === 1, "lease on reconnect")

    release(null)
    await sleep(50)
    expect(resultFramesFor(peers[0] as Peer, "cmd-1")).toHaveLength(0)
    expect(resultFramesFor(peers[1] as Peer, "cmd-1")).toHaveLength(0)
  })

  test("a command that ran reports its result on the live socket", async () => {
    const { peers } = await setup(async (commandId) => ({
      outcome: { commandId, boxId: "box-1", ok: true, reported: false },
      vm: null,
    }))
    await waitFor(() => peers.length === 1 && peers[0]?.frames.some((frame) => frame._tag === "hello") === true, "hello")
    peers[0]?.socket.send(JSON.stringify({ _tag: "command", commandId: "cmd-2", command: destroy }))
    await waitFor(() => resultFramesFor(peers[0] as Peer, "cmd-2").length === 1, "result frame")
    expect(resultFramesFor(peers[0] as Peer, "cmd-2")[0]).toMatchObject({ ok: true })
  })
})

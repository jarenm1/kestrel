// Test-only control plane for packages/host/nix/test.nix. It speaks the control side of protocol/src/nest.ts
// (`/nest/hosts/connect`, bearer secret, `hello` / `command` / `result` / `lease`) and exposes a small HTTP surface for
// the NixOS test script: `POST /test/command` sends one command and returns its result, `GET /test/state` reports what
// the host last said. It never decides placement by itself; the test script issues every command.

type Vm = { boxId: string; state: string; volumeRef: string | null; [key: string]: unknown }

type HostFrame = { _tag: string; [key: string]: unknown }

const HOST_ID = process.env.HOST_ID ?? ""
const HOST_SECRET = process.env.HOST_SECRET ?? ""
const LEASE_MS = 5 * 60_000
const LEASE_EVERY_MS = 30_000
const COMMAND_TIMEOUT_MS = 900_000

let host: { send(data: string): void } | null = null
let hello: HostFrame | null = null
let capacity: unknown = null
const vms = new Map<string, Vm>()
const wakeRequests: string[] = []
const frameTags: string[] = []
const waiting = new Map<string, (frame: HostFrame) => void>()
let seq = 0
const enrollTokens = new Map<string, string>()

const send = (frame: unknown): void => {
  if (host === null) throw new Error("host is not connected")
  host.send(JSON.stringify(frame))
}

const sendLease = (): void => {
  if (host !== null) send({ _tag: "lease", validUntil: Date.now() + LEASE_MS })
}

const runCommand = (command: unknown): Promise<HostFrame> => {
  const { promise, resolve, reject } = Promise.withResolvers<HostFrame>()
  const commandId = "cmd-" + ++seq
  const timer = setTimeout(() => {
    waiting.delete(commandId)
    reject(new Error("no result for " + commandId))
  }, COMMAND_TIMEOUT_MS)
  waiting.set(commandId, (frame) => {
    clearTimeout(timer)
    resolve(frame)
  })
  try {
    send({ _tag: "command", commandId, command })
  } catch (error) {
    clearTimeout(timer)
    waiting.delete(commandId)
    reject(error)
  }
  return promise
}

const asFrame = (value: unknown): HostFrame => {
  if (typeof value !== "object" || value === null || !("_tag" in value) || typeof value._tag !== "string") {
    throw new Error("frame without _tag")
  }
  return value as HostFrame
}

setInterval(sendLease, LEASE_EVERY_MS)

Bun.serve({
  port: 9000,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/nest/hosts/connect") {
      if (req.headers.get("authorization") !== "Bearer " + HOST_SECRET || req.headers.get("x-kestrel-nest-host") !== HOST_ID) {
        return new Response("forbidden", { status: 403 })
      }
      return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 400 })
    }
    if (url.pathname === "/box/nest/enroll" && req.method === "POST") {
      const body = (await req.json()) as { boxId?: string; token?: string }
      if (body.boxId === undefined || enrollTokens.get(body.boxId) !== body.token) {
        return new Response("refused", { status: 403 })
      }
      return Response.json({ secret: "box-secret-" + body.boxId })
    }
    if (url.pathname === "/test/command" && req.method === "POST") {
      try {
        const command = await req.json()
        if (command._tag === "create") enrollTokens.set(command.boxId, command.enrollToken)
        return Response.json(await runCommand(command))
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 })
      }
    }
    if (url.pathname === "/test/state") {
      return Response.json({ hello, capacity, vms: [...vms.values()], wakeRequests, frameTags })
    }
    return new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws) {
      host = ws
    },
    message(_ws, raw) {
      const frame = asFrame(JSON.parse(String(raw)))
      frameTags.push(frame._tag)
      switch (frame._tag) {
        case "hello": {
          hello = frame
          capacity = frame.capacity
          sendLease()
          break
        }
        case "inventory": {
          for (const vm of frame.vms as Vm[]) vms.set(vm.boxId, vm)
          break
        }
        case "capacity":
          capacity = frame.capacity
          break
        case "vm": {
          const vm = frame.vm as Vm
          vms.set(vm.boxId, vm)
          break
        }
        case "result": {
          if (frame.vm) {
            const vm = frame.vm as Vm
            vms.set(vm.boxId, vm)
          }
          const done = waiting.get(frame.commandId as string)
          waiting.delete(frame.commandId as string)
          done?.(frame)
          break
        }
        case "wakeRequest":
          wakeRequests.push(frame.boxId as string)
          break
        default:
          throw new Error("unexpected host frame " + frame._tag)
      }
    },
    close() {
      host = null
    },
  },
})

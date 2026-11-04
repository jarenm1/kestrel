import { randomUUID } from "node:crypto"
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { Schema } from "effect"
import { HostError, UnknownBoxError, WakeTimeoutError, errorMessage } from "./errors"
import { STRICT } from "./schema"
import type { VmManager } from "./vm-manager"

const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.nonNegative())

const IngressActivityBody = Schema.Struct({
  boxes: Schema.Array(
    Schema.Struct({
      boxId: Schema.String.pipe(Schema.minLength(1)),
      openConnections: NonNegativeInt,
      lastRequestAt: Schema.NullOr(NonNegativeInt),
    }),
  ),
})

const OperatorAction = Schema.Literal("suspend", "park", "destroy")

const BOX_ROUTE = /^\/v1\/boxes\/([^/]+)(?:\/(route|wake|suspend|park|destroy))?$/

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

/**
 * The host's local API, served on a unix socket. Ingress asks where a box is and wakes it; operators list and act on
 * VMs. Unknown boxes answer 404, a wake that does not reach `running` answers 503, other failures answer 500.
 */
export const handleLocalRequest = async (manager: VmManager, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const path = url.pathname
  try {
    if (request.method === "GET" && path === "/v1/vms") return json(manager.reports())
    if (request.method === "POST" && path === "/v1/ingress/activity") {
      const decoded = Schema.decodeUnknownEither(IngressActivityBody, STRICT)(await request.json())
      if (decoded._tag === "Left") return json({ error: "invalid ingress activity body" }, 400)
      manager.reportActivity(decoded.right.boxes)
      return new Response(null, { status: 204 })
    }
    const match = BOX_ROUTE.exec(path)
    if (match !== null) {
      const boxId = decodeURIComponent(match[1] ?? "")
      const action = match[2]
      if (action === undefined && request.method === "GET") {
        const report = manager.reports().find((vm) => vm.boxId === boxId)
        return report === undefined ? json({ error: `unknown box ${boxId}` }, 404) : json(report)
      }
      if (action === "route" && request.method === "GET") return json(manager.route(boxId))
      if (action === "wake" && request.method === "POST") return json({ upstream: await manager.wake(boxId) })
      const operator = OperatorAction.literals.find((literal) => literal === action)
      if (operator !== undefined && request.method === "POST") {
        const { outcome, vm } = await manager.execute(randomUUID(), { _tag: operator, boxId })
        return json({ ok: outcome.ok, error: outcome.error ?? null, vm }, outcome.ok ? 200 : 409)
      }
    }
    return json({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof UnknownBoxError) return json({ error: error.message }, 404)
    if (error instanceof WakeTimeoutError) return json({ error: error.message }, 503)
    return json({ error: errorMessage(error) }, 500)
  }
}

/** The API socket is shared with kestrel-ingress through this group: the directory is 0750 and the socket 0660. */
const INGRESS_GROUP = "kestrel-ingress"

const groupGid = (name: string): number => {
  const entry = readFileSync("/etc/group", "utf8").split("\n").find((line) => line.startsWith(`${name}:`))
  const gid = entry === undefined ? Number.NaN : Number(entry.split(":")[2])
  if (!Number.isInteger(gid)) throw new HostError(`group ${name} does not exist`)
  return gid
}

/** Serves the local API on `socketPath`. Replaces a stale socket file; the socket is group-writable for ingress. */
export const startLocalApi = (opts: { readonly socketPath: string; readonly manager: VmManager }): { stop(): void } => {
  const gid = groupGid(INGRESS_GROUP)
  const dir = dirname(opts.socketPath)
  mkdirSync(dir, { recursive: true, mode: 0o750 })
  chownSync(dir, -1, gid)
  chmodSync(dir, 0o750)
  rmSync(opts.socketPath, { force: true })
  const server = Bun.serve({
    unix: opts.socketPath,
    fetch: (request) => handleLocalRequest(opts.manager, request),
  })
  chownSync(opts.socketPath, -1, gid)
  chmodSync(opts.socketPath, 0o660)
  return {
    stop: () => {
      server.stop(true)
      rmSync(opts.socketPath, { force: true })
    },
  }
}

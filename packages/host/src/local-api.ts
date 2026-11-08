import { randomUUID } from "node:crypto"
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
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

/** Unknown boxes answer 404, a wake that does not reach `running` answers 503, other failures answer 500. */
const failure = (error: unknown): Response => {
  if (error instanceof UnknownBoxError) return json({ error: error.message }, 404)
  if (error instanceof WakeTimeoutError) return json({ error: error.message }, 503)
  return json({ error: errorMessage(error) }, 500)
}

/**
 * The ingress surface, served on `api.sock`: kestrel-ingress asks where a box is, wakes it and reports activity. Nothing
 * else is reachable from here; operator actions live on `operator.sock`.
 */
export const handleIngressRequest = async (manager: VmManager, request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  try {
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
      if (action === "route" && request.method === "GET") return json(manager.route(boxId))
      if (action === "wake" && request.method === "POST") return json({ upstream: await manager.wake(boxId) })
    }
    return json({ error: "not found" }, 404)
  } catch (error) {
    return failure(error)
  }
}

/**
 * The operator surface, served on `operator.sock` (root only): lists and inspects VMs and applies suspend, park and
 * destroy. Refused commands answer 409 with the outcome.
 */
export const handleOperatorRequest = async (manager: VmManager, request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  try {
    if (request.method === "GET" && path === "/v1/vms") return json(manager.reports())
    const match = BOX_ROUTE.exec(path)
    if (match !== null) {
      const boxId = decodeURIComponent(match[1] ?? "")
      const action = match[2]
      if (action === undefined && request.method === "GET") {
        const report = manager.reports().find((vm) => vm.boxId === boxId)
        return report === undefined ? json({ error: `unknown box ${boxId}` }, 404) : json(report)
      }
      const operator = OperatorAction.literals.find((literal) => literal === action)
      if (operator !== undefined && request.method === "POST") {
        const ownerEpoch = manager.epochOf(boxId)
        if (ownerEpoch === null) return json({ error: `unknown box ${boxId}` }, 404)
        const { outcome, vm } = await manager.executeOperator(randomUUID(), { _tag: operator, boxId, ownerEpoch })
        return json({ ok: outcome.ok, error: outcome.error ?? null, vm }, outcome.ok ? 200 : 409)
      }
    }
    return json({ error: "not found" }, 404)
  } catch (error) {
    return failure(error)
  }
}

const groupGid = (name: string): number => {
  const entry = readFileSync("/etc/group", "utf8").split("\n").find((line) => line.startsWith(`${name}:`))
  const gid = entry === undefined ? Number.NaN : Number(entry.split(":")[2])
  if (!Number.isInteger(gid)) throw new HostError(`group ${name} does not exist`)
  return gid
}

/** The two sockets the host serves. */
export interface LocalApi {
  stop(): void
}

/**
 * Serves both local sockets in `runDir`. The directory is 0750 and group `ingressGroup`; `api.sock` is 0660 in that group
 * so kestrel-ingress can reach it. `operator.sock` is 0600 and owned by the agent's user, so the group cannot reach it.
 * Stale socket files are replaced.
 */
export const startLocalApi = (opts: {
  readonly runDir: string
  readonly ingressGroup: string
  readonly manager: VmManager
}): LocalApi => {
  const gid = groupGid(opts.ingressGroup)
  mkdirSync(opts.runDir, { recursive: true, mode: 0o750 })
  chownSync(opts.runDir, -1, gid)
  chmodSync(opts.runDir, 0o750)

  const ingressSocket = join(opts.runDir, "api.sock")
  const operatorSocket = join(opts.runDir, "operator.sock")
  rmSync(ingressSocket, { force: true })
  rmSync(operatorSocket, { force: true })
  const ingress = Bun.serve({
    unix: ingressSocket,
    fetch: (request) => handleIngressRequest(opts.manager, request),
  })
  const operator = Bun.serve({
    unix: operatorSocket,
    fetch: (request) => handleOperatorRequest(opts.manager, request),
  })
  chownSync(ingressSocket, -1, gid)
  chmodSync(ingressSocket, 0o660)
  chmodSync(operatorSocket, 0o600)
  return {
    stop: () => {
      ingress.stop(true)
      operator.stop(true)
      rmSync(ingressSocket, { force: true })
      rmSync(operatorSocket, { force: true })
    },
  }
}

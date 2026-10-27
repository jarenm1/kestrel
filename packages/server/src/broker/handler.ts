import { Effect } from "effect"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { BROKER_PROVIDERS, type BrokerProvider, CredentialBroker, type CredentialBrokerShape, UPSTREAM_BASE } from "./index"

export const BROKER_PREFIX = "/broker/"

/** Headers never forwarded in either direction (RFC 7230 hop-by-hop plus proxy-managed ones). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** Client headers replaced or dropped: the real key is injected, and body framing is recomputed. */
const CLIENT_DROP = new Set(["host", "content-length", "accept-encoding", "authorization", "x-api-key"])

/** Upstream headers dropped: body is re-streamed without encoding, so framing headers are recomputed. */
const UPSTREAM_DROP = new Set(["content-encoding", "content-length"])

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> => {
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
  req.on("error", reject)
  return promise
}

const upstreamHeaders = (headers: IncomingHttpHeaders, provider: BrokerProvider, key: string): Headers => {
  const out = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || CLIENT_DROP.has(name)) continue
    out.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  if (provider === "anthropic") out.set("x-api-key", key)
  else out.set("authorization", `Bearer ${key}`)
  return out
}

/**
 * Forwards `/broker/<token>/<provider>/<path>` to the provider with the real key injected.
 * The token is the only credential the sandbox holds; it is checked against live runs.
 */
export const handleBroker = async (
  broker: CredentialBrokerShape,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const match = /^\/broker\/([^/?#]+)\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/.exec(req.url ?? "")
  if (!match) return sendJson(res, 404, { _tag: "NotFound", message: "no such broker route" })
  const [, token = "", providerRaw = "", rest = "", query = ""] = match

  const grant = await Effect.runPromise(broker.grantForToken(token))
  if (grant === null) return sendJson(res, 401, { _tag: "Unauthorized", message: "unknown or revoked broker token" })

  const provider = BROKER_PROVIDERS.find((p) => p === providerRaw)
  if (provider === undefined) return sendJson(res, 404, { _tag: "NotFound", message: `no broker for ${providerRaw}` })

  const key = await Effect.runPromise(broker.upstreamKey(provider, grant.user))
  if (key === null) {
    return sendJson(res, 424, { _tag: "MissingCredential", message: `no ${provider} credential is configured` })
  }

  const method = req.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req)
  const url = `${UPSTREAM_BASE[provider]}${rest}${query}`

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method,
      headers: upstreamHeaders(req.headers, provider, key),
      body,
      redirect: "manual",
    })
  } catch {
    return sendJson(res, 502, { _tag: "BadGateway", message: `upstream ${provider} unreachable` })
  }

  res.statusCode = upstream.status
  upstream.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || UPSTREAM_DROP.has(name)) return
    res.setHeader(name, value)
  })
  if (upstream.body === null) return void res.end()

  const reader = upstream.body.getReader()
  res.on("close", () => {
    if (!res.writableFinished) void reader.cancel().catch(() => undefined)
  })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

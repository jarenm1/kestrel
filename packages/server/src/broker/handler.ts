import { Effect } from "effect"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { VERSION } from "../config"
import {
  BROKER_PROVIDERS,
  BROKER_UPSTREAMS,
  DEFAULT_BROKER_API,
  type BrokerApi,
  type BrokerProvider,
  type BrokerUpstream,
  type CredentialBrokerShape,
} from "./index"

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

const upstreamHeaders = (headers: IncomingHttpHeaders, upstream: BrokerUpstream, key: string): Headers => {
  const out = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || CLIENT_DROP.has(name)) continue
    out.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  if (upstream.keyHeader === "x-api-key") out.set("x-api-key", key)
  else out.set("authorization", `Bearer ${key}`)
  return out
}

/** One resolved destination: the provider's own base for the requested API, and the path to append to it. */
export interface BrokerTarget {
  readonly upstream: BrokerUpstream
  readonly path: string
}

/**
 * Resolves a broker path to the provider's documented endpoint. An OpenAI route carries `/v1` in the broker path;
 * each provider's base already names its own versioned path, so that literal `/v1` is consumed here. `null` means the
 * provider documents no such API (never a translation attempt).
 */
export const brokerTarget = (provider: BrokerProvider, api: BrokerApi, path: string): BrokerTarget | null => {
  const upstreams = BROKER_UPSTREAMS[provider]
  if (api === "anthropic") {
    return upstreams.anthropic === null ? null : { upstream: upstreams.anthropic, path }
  }
  if (upstreams.openai === null) return null
  const withoutVersion = path === "/v1" ? "/" : path.startsWith("/v1/") ? path.slice(3) : path
  const responses = withoutVersion === "/responses" || withoutVersion.startsWith("/responses/")
  if (responses) {
    return upstreams.openai.responses === null
      ? null
      : { upstream: upstreams.openai.responses, path: withoutVersion }
  }
  return { upstream: upstreams.openai.chat, path: withoutVersion }
}

/**
 * Forwards `/broker/<token>/<provider>/<path>` to the provider with the real key injected.
 *
 * The legacy path (`/<provider>/<path>`) keeps its meaning: Anthropic Messages for every gateway, and the OpenAI
 * Responses API for `openai`. The explicit form (`/<provider>/<anthropic|openai>/<path>`) names the native API a
 * harness speaks, so one credential can serve Claude Code, Codex and OpenCode without a translation layer.
 *
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
  if (!grant.providers.includes(provider)) {
    return sendJson(res, 403, { _tag: "Forbidden", message: `this run is not authorized for ${provider}` })
  }
  // Codex probes for a websocket transport before falling back to HTTP. The broker tunnels HTTP only, so answer the
  // upgrade directly instead of forwarding a request whose upgrade headers were stripped.
  if (`${req.headers.upgrade ?? ""} ${req.headers.connection ?? ""}`.toLowerCase().includes("websocket")) {
    return sendJson(res, 426, { _tag: "UpgradeRequired", message: "the broker does not tunnel websockets" })
  }

  const tail = rest === "" ? "/" : rest
  const segment = tail.slice(1).split("/", 1)[0] ?? ""
  const explicit = segment === "anthropic" || segment === "openai"
  const api: BrokerApi = explicit ? (segment as BrokerApi) : DEFAULT_BROKER_API[provider]
  const path = explicit ? tail.slice(segment.length + 1) || "/" : tail
  const target = brokerTarget(provider, api, path)
  if (target === null) {
    return sendJson(res, 404, { _tag: "NotFound", message: `${provider} has no ${api} API` })
  }

  // OpenCode Go's key comes from the user's OpenCode credential store, exported once when the run started: it is not
  // in Kestrel's store, and it never reaches the sandbox.
  const key =
    provider === "opencode-go" && grant.opencodeGoKey !== null && grant.opencodeGoKey !== ""
      ? grant.opencodeGoKey
      : await Effect.runPromise(broker.upstreamKey(provider, grant.user))
  if (key === null) {
    return sendJson(res, 424, { _tag: "MissingCredential", message: `no ${provider} credential is configured` })
  }

  const method = req.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req)
  const headers = upstreamHeaders(req.headers, target.upstream, key)
  if (provider === "opencode-go") {
    // Console routes a Go conversation by a stable session and expects a client that names itself. Native Claude
    // Code and Codex session headers are forwarded untouched; this only fills what the harness omitted. The user
    // agent is Kestrel's own: the sandbox's HTTP library name is not who is calling.
    if ((headers.get("x-opencode-session") ?? "") === "") {
      headers.set("x-opencode-session", grant.opencodeSession)
    }
    headers.set("user-agent", `kestrel/${VERSION}`)
  }
  const url = `${target.upstream.base}${target.path}${query}`

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method,
      headers,
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

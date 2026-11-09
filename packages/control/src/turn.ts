/**
 * `POST /box/turn`: managed TURN credentials from Cloudflare Realtime, for boxes on networks that only let WebRTC
 * through a relay. The provider API token stays here; a box gets only the short-lived username and credential it needs.
 *
 * A box authenticates like its other box-only routes: the legacy relay token, a managed box's secret with its id, or a
 * user's registered box secret with its id. Credentials are cached per box until five minutes before they expire, so a
 * retrying box does not spend a provider call, and concurrent requests share one call.
 */
import { Schema } from "effect"
import { BOX_ID_HEADER, DesktopRtcIceServer, type BoxTurnCredentials, type DesktopTurnIssue } from "@cloudagents/protocol"
import { errorResponse, json, safeEqual } from "./http"
import { hub, type Env } from "./env"

/** The provider issues credentials for this long; the response says so in `expiresAt`. */
export const TURN_CREDENTIAL_TTL_SECONDS = 60 * 60
/** Extracted from the credentials this long before they expire, so a box never negotiates with a stale one. */
export const TURN_CREDENTIAL_REFRESH_MS = 5 * 60 * 1000
/** An isolate caches at most this many boxes' credentials; the least recently stored is dropped first. */
export const MAX_TURN_CREDENTIAL_CACHE = 256
/** A provider call that has not answered by now is useless to the box that asked for it: the box gives up at 3s. */
const TURN_PROVIDER_TIMEOUT_MS = 2_000

const TURN_PROVIDER_ORIGIN = "https://rtc.live.cloudflare.com"

const INCOMPLETE_CONFIG =
  "managed TURN configuration is incomplete: KESTREL_TURN_KEY_ID and KESTREL_TURN_API_TOKEN must be set together"
const PROVIDER_UNAVAILABLE = "managed TURN provider is unavailable"
const PROVIDER_UNUSABLE = "managed TURN provider returned an unusable response"

/** The provider's response, decoded with the wire schema the clients already use for ICE servers. */
const ProviderResponse = Schema.Struct({ iceServers: Schema.Array(DesktopRtcIceServer) })

/** A scheme a browser's `RTCPeerConnection` accepts; anything else means the provider answered with something else. */
const ICE_URL_SCHEME = /^(stun|stuns|turn|turns):/i

class TurnProviderError extends Error {
  constructor(message: string, readonly issue: DesktopTurnIssue) {
    super(message)
  }
}

/** A safe failure body: the issue enum names the fix without exposing provider text or credentials. */
const turnError = (status: number, tag: string, message: string, issue: DesktopTurnIssue): Response =>
  json({ _tag: tag, message, issue }, status)

type TurnProviderConfig = { readonly keyId: string; readonly token: string }

/**
 * The provider's credentials, or why this Worker cannot ask for them. A half-configured provider is an operator error,
 * not a box error, so it is reported rather than treated as "not configured".
 */
const providerConfig = (env: Env): TurnProviderConfig | "absent" | "incomplete" => {
  const keyId = env.KESTREL_TURN_KEY_ID?.trim() ?? ""
  const token = env.KESTREL_TURN_API_TOKEN?.trim() ?? ""
  if (keyId === "" && token === "") return "absent"
  return keyId === "" || token === "" ? "incomplete" : { keyId, token }
}

/**
 * Which box is calling, named so its credentials cache apart from every other box's. Null when it proves nothing:
 * the relay token, a managed box's own secret and id, or a user's registered box secret and id.
 */
const boxIdentity = async (request: Request, env: Env): Promise<string | null> => {
  const auth = request.headers.get("authorization") ?? ""
  const secret = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : ""
  if (secret === "") return null
  if (env.BOX_TOKEN !== undefined && env.BOX_TOKEN !== "" && (await safeEqual(secret, env.BOX_TOKEN))) return "relay"
  const boxId = request.headers.get(BOX_ID_HEADER) ?? ""
  if (boxId === "") return null
  // The identity includes the Hub's durable generation, so rotating a secret or deleting the box misses the Worker's
  // cache. It is read from the Hub per request rather than inferred from an in-isolate map.
  const managed = await hub(env).managedBoxTurnIdentity(boxId, secret)
  if (managed !== null) return managed
  // A user's own box proves itself the way `/box/self` does, but gets no owner credentials from this check.
  return hub(env).boxTurnIdentity(boxId, secret)
}

/** Accept only usable provider ICE lists containing authenticated TURN over TLS on port 443. */
const usableIceServers = (body: unknown): ReadonlyArray<DesktopRtcIceServer> | null => {
  const decoded = Schema.decodeUnknownEither(ProviderResponse)(body)
  if (decoded._tag === "Left") return null
  const servers = decoded.right.iceServers
  const wellFormed = servers.every(
    (server) => server.urls.length > 0 && server.urls.every((url) => ICE_URL_SCHEME.test(url)),
  )
  const hasTls443 = servers.some((server) =>
    !!server.username?.trim() && !!server.credential?.trim() &&
    server.urls.some((url) => /^turns:(?:\[[^\]]+\]|[^:/?#]+):443\?transport=tcp$/i.test(url)),
  )
  return wellFormed && hasTls443 ? servers : null
}

/** One provider call. Its failures all become safe messages: the provider's body and token never reach the box. */
const fetchProviderCredentials = async (config: TurnProviderConfig, now: number): Promise<BoxTurnCredentials> => {
  const url = `${TURN_PROVIDER_ORIGIN}/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "user-agent": "kestrel-control-plane",
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      signal: AbortSignal.timeout(TURN_PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw new TurnProviderError(PROVIDER_UNAVAILABLE, "provider-unavailable")
  }
  if (!response.ok) throw new TurnProviderError(PROVIDER_UNAVAILABLE, "provider-unavailable")
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new TurnProviderError(PROVIDER_UNUSABLE, "provider-unusable")
  }
  const iceServers = usableIceServers(body)
  if (iceServers === null) throw new TurnProviderError(PROVIDER_UNUSABLE, "provider-unusable")
  // The provider's credentials live exactly the TTL the request asked for.
  return { iceServers, expiresAt: now + TURN_CREDENTIAL_TTL_SECONDS * 1000 }
}

const credentialsCache = new Map<string, BoxTurnCredentials>()
const pendingCalls = new Map<string, Promise<BoxTurnCredentials>>()

/** Stores `credentials`, dropping expired entries and then the oldest, so the cache stays bounded. */
const remember = (key: string, credentials: BoxTurnCredentials, now: number): void => {
  for (const [cachedKey, cached] of credentialsCache) if (cached.expiresAt <= now) credentialsCache.delete(cachedKey)
  while (credentialsCache.size >= MAX_TURN_CREDENTIAL_CACHE) {
    const oldest = credentialsCache.keys().next().value
    if (oldest === undefined) break
    credentialsCache.delete(oldest)
  }
  credentialsCache.set(key, credentials)
}

/**
 * Credentials for `identity`, from the cache while they are more than five minutes from expiring, or from one provider
 * call shared by every concurrent request for the same box. Failures are not cached, so a later retry asks again.
 */
const credentialsFor = (
  identity: string,
  config: TurnProviderConfig,
  now: number,
): Promise<BoxTurnCredentials> => {
  // The key id is in the key, so rotating the provider key does not serve credentials minted under the old one. The
  // identity itself carries the Hub's durable TURN generation, so rotation/deletion misses in every isolate.
  const key = `${identity}\u0000${config.keyId}`
  const cached = credentialsCache.get(key)
  if (cached !== undefined && cached.expiresAt - now > TURN_CREDENTIAL_REFRESH_MS) return Promise.resolve(cached)
  const pending = pendingCalls.get(key)
  if (pending !== undefined) return pending
  const call = fetchProviderCredentials(config, now)
    .then((credentials) => {
      remember(key, credentials, now)
      return credentials
    })
    .finally(() => pendingCalls.delete(key))
  pendingCalls.set(key, call)
  return call
}

/**
 * `POST /box/turn` -> BoxTurnCredentials for an authenticated box, 204 when the provider is not configured, 401 for a
 * caller that proves no box, and 502 for a misconfigured, unavailable or malformed provider. Credentials are never
 * answered to a caller that did not authenticate first.
 */
export const handleBoxTurn = async (request: Request, env: Env, now = Date.now()): Promise<Response> => {
  if (request.method !== "POST") return errorResponse(405, "MethodNotAllowed", `${request.method} not allowed`)
  const identity = await boxIdentity(request, env)
  if (identity === null) return turnError(401, "Unauthorized", "invalid box credentials", "control-rejected")
  const config = providerConfig(env)
  if (config === "absent") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
  if (config === "incomplete") return turnError(502, "BadGateway", INCOMPLETE_CONFIG, "configuration-incomplete")
  try {
    return json(await credentialsFor(identity, config, now))
  } catch (err) {
    if (err instanceof TurnProviderError) return turnError(502, "BadGateway", err.message, err.issue)
    throw err
  }
}

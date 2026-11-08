/**
 * Managed TURN credentials for desktop peers. A registered box asks the control plane for short-lived provider
 * credentials; the provider token stays on the control plane, and the box's own identity (its secret or the relay
 * token) is the only thing it presents. A standalone box has no control-plane identity and keeps its local ICE
 * configuration.
 */
import { Schema } from "effect"
import { BOX_ID_HEADER, BOX_TURN_PATH, BoxTurnCredentials, type DesktopRtcIceServer } from "@cloudagents/protocol"
import { controlBase } from "../control/client"
import type { ServerConfig } from "../config"
import { mintIceServers, type TurnConfigDiagnostics, type WebRtcSettings } from "./webrtc"

/** Refresh this long before the provider expires credentials, so a viewer retry never receives stale ones. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
/** The viewer waits for its desktop, not the control plane: past this the box's own config is sent without managed TURN. */
const CONTROL_TIMEOUT_MS = 3_000
const INVALID_ANSWER = "control plane sent an unexpected TURN answer"
const EXPIRED_ANSWER = "control plane sent expired TURN credentials"
const NO_TURN_ANSWER = "control plane sent no usable TURN credentials"
const TURN_URL = /^turns?:/i
const STUN_URL = /^stuns?:/i

export interface ManagedTurnResult {
  /** The provider's ICE servers, or null when there is none to add (including provider not configured). */
  readonly iceServers: ReadonlyArray<DesktopRtcIceServer> | null
  /** A sanitized warning when the control plane could not supply credentials; null when it supplied or declined. */
  readonly warning: string | null
}

export interface ManagedTurn {
  readonly servers: () => Promise<ManagedTurnResult>
}

/** What this box presents to the TURN endpoint: its own registered identity, else the relay's. */
interface TurnIdentity {
  readonly controlUrl: string
  readonly headers: Readonly<Record<string, string>>
}

const turnIdentity = (config: ServerConfig): TurnIdentity | null => {
  if (config.direct !== null) {
    return {
      controlUrl: config.direct.controlUrl,
      headers: { authorization: `Bearer ${config.direct.boxSecret}`, [BOX_ID_HEADER]: config.direct.boxId },
    }
  }
  if (config.relay !== null) {
    return {
      controlUrl: config.relay.controlUrl,
      headers: { authorization: `Bearer ${config.relay.boxToken}` },
    }
  }
  return null
}

/** Provider credentials can be short-lived; keep the expiry so the next call can decide whether it needs new ones. */
interface FetchedCredentials extends ManagedTurnResult {
  readonly expiresAt: number | null
}

const unreachable = (error: unknown): string => {
  const name = error instanceof Error ? error.name : ""
  return `managed TURN unavailable: control plane ${name === "TimeoutError" || name === "AbortError" ? "timed out" : "unreachable"}`
}

/**
 * Provider entries are kept only for usable URLs and credentials: STUN always, TURN only when both its username and
 * credential are present. An entry that carries TURN without credentials still contributes its STUN URLs, and an entry
 * with no usable URL at all is dropped.
 */
const usableIceServers = (servers: ReadonlyArray<DesktopRtcIceServer>): DesktopRtcIceServer[] =>
  servers.flatMap((server): DesktopRtcIceServer[] => {
    const authenticated = (server.username?.trim() ?? "") !== "" && (server.credential?.trim() ?? "") !== ""
    const urls = server.urls.filter((url) => STUN_URL.test(url) || (authenticated && TURN_URL.test(url)))
    if (urls.length === 0) return []
    return urls.some((url) => TURN_URL.test(url))
      ? [{ urls, username: server.username, credential: server.credential }]
      : [{ urls }]
  })

const fetchManaged = async (identity: TurnIdentity): Promise<FetchedCredentials> => {
  let response: Response
  try {
    response = await fetch(`${controlBase(identity.controlUrl)}${BOX_TURN_PATH}`, {
      method: "POST",
      headers: identity.headers,
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    })
  } catch (error) {
    return { iceServers: null, expiresAt: null, warning: unreachable(error) }
  }
  // No provider credentials configured on the control plane: keep the box's own ICE configuration.
  if (response.status === 204) return { iceServers: null, expiresAt: null, warning: null }
  if (!response.ok) {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: control plane answered ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: ${INVALID_ANSWER}` }
  }
  let credentials: BoxTurnCredentials
  try {
    credentials = Schema.decodeUnknownSync(BoxTurnCredentials)(body)
  } catch {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: ${INVALID_ANSWER}` }
  }
  if (!Number.isFinite(credentials.expiresAt)) {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: ${INVALID_ANSWER}` }
  }
  if (credentials.expiresAt <= Date.now()) {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: ${EXPIRED_ANSWER}` }
  }
  const servers = usableIceServers(credentials.iceServers)
  if (!servers.some((server) => server.urls.some((url) => TURN_URL.test(url)))) {
    return { iceServers: null, expiresAt: null, warning: `managed TURN unavailable: ${NO_TURN_ANSWER}` }
  }
  return { iceServers: servers, expiresAt: credentials.expiresAt, warning: null }
}

interface CachedCredentials {
  readonly iceServers: ReadonlyArray<DesktopRtcIceServer>
  readonly expiresAt: number
}

/**
 * One resolver per server config, so every viewer shares the same provider credentials and concurrent refreshes are
 * coalesced. Failures and "provider not configured" answers are not cached: the next config request asks again.
 */
const resolvers = new WeakMap<ServerConfig, ManagedTurn>()

export const managedTurn = (config: ServerConfig): ManagedTurn => {
  const existing = resolvers.get(config)
  if (existing !== undefined) return existing

  const identity = turnIdentity(config)
  let cached: CachedCredentials | null = null
  let inflight: Promise<ManagedTurnResult> | null = null

  const refresh = async (): Promise<ManagedTurnResult> => {
    const fetched = await fetchManaged(identity!)
    if (fetched.iceServers !== null && fetched.expiresAt !== null) {
      const now = Date.now()
      // Cache only while the credentials have a useful remainder; an already-expiring answer is still usable now, but
      // the next request must fetch again rather than inherit it.
      if (fetched.expiresAt - REFRESH_MARGIN_MS > now) {
        cached = { iceServers: fetched.iceServers, expiresAt: fetched.expiresAt }
      }
    }
    return { iceServers: fetched.iceServers, warning: fetched.warning }
  }

  const servers = async (): Promise<ManagedTurnResult> => {
    if (identity === null) return { iceServers: null, warning: null }
    if (cached !== null && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) {
      return { iceServers: cached.iceServers, warning: null }
    }
    if (inflight !== null) return inflight
    const pending = refresh()
    inflight = pending
    const clear = () => {
      if (inflight === pending) inflight = null
    }
    pending.then(clear, clear)
    return pending
  }

  const resolver: ManagedTurn = { servers }
  resolvers.set(config, resolver)
  return resolver
}

/** The operator configured TURN locally: its own static credentials or a REST secret. Both win over managed TURN. */
export const hasExplicitTurn = (settings: WebRtcSettings): boolean =>
  settings.turn !== null ||
  settings.iceServers.some((server) => server.urls.some((url) => /^turns?:/i.test(url)))

/**
 * What the box's own configuration provides, without asking the control plane. A TURN URL without usable credentials
 * (or a REST secret with no TURN URL) is an explicit local misconfiguration: report it rather than call it absent.
 */
const localTurnDiagnostics = (settings: WebRtcSettings): TurnConfigDiagnostics => {
  const rest = settings.turn
  const restUsable = rest !== null && rest.secret.trim() !== "" && rest.urls.some((url) => TURN_URL.test(url))
  const turnServers = settings.iceServers.filter((server) => server.urls.some((url) => TURN_URL.test(url)))
  const staticUsable = turnServers.some(
    (server) => (server.username?.trim() ?? "") !== "" && (server.credential?.trim() ?? "") !== "",
  )
  if (restUsable || staticUsable) return { source: "local", status: "configured", failure: null }
  if (rest === null && turnServers.length === 0) {
    return { source: "none", status: "not-configured", failure: null }
  }
  return { source: "local", status: "unavailable", failure: "turn-credentials" }
}

export interface SessionIceServers {
  readonly iceServers: DesktopRtcIceServer[]
  readonly warning: string | null
  /** Whether `iceServers` carries provider-issued TURN, which is the box's to use with a shorter allocation wait. */
  readonly managed: boolean
  /** Redacted source and credential outcome for `rtc.diagnostics`; never the provider's message or a URL. */
  readonly turn: TurnConfigDiagnostics
}

/**
 * The ICE servers one peer of a desktop session gets — the viewer's config and the box's own peer — with managed TURN
 * appended when the box is registered and has no operator-configured TURN. Both ends allocate a relay, so a session
 * still connects when neither side has a candidate the other can reach. Local configuration is never replaced.
 */
export const sessionIceServers = async (
  settings: WebRtcSettings,
  managed: ManagedTurn | null,
  taskId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SessionIceServers> => {
  const local = mintIceServers(settings, taskId, nowSeconds)
  if (managed === null || hasExplicitTurn(settings)) {
    return { iceServers: local, warning: null, managed: false, turn: localTurnDiagnostics(settings) }
  }
  const result = await managed.servers()
  if (result.iceServers === null) {
    // A provider that declined (204) or a standalone box asked for nothing: no TURN, no credential failure. A fetch,
    // identity, expired-credential, or malformed-answer warning leaves the box without the relay it expected.
    return {
      iceServers: local,
      warning: result.warning,
      managed: false,
      turn: result.warning === null
        ? { source: "none", status: "not-configured", failure: null }
        : { source: "managed", status: "unavailable", failure: "turn-credentials" },
    }
  }
  return {
    iceServers: [...local, ...result.iceServers],
    warning: result.warning,
    managed: true,
    turn: { source: "managed", status: "configured", failure: null },
  }
}

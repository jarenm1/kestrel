import type { Env } from "./env"
import { UpstreamError } from "./http"
import type { OAuthProvider } from "./providers"

/**
 * An expiring access token is refreshed this long before it expires: room for alarm latency and a few retries. Kept
 * short on purpose: GitHub revokes the previous access token the moment its refresh token is spent, so a box holding
 * that copy loses it early by exactly this much, until its next request fetches the new one.
 */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000
/** A refresh that failed for any reason but a refused refresh token runs again after this long, doubling per failure. */
export const REFRESH_RETRY_MS = 60 * 1000
/** The retry delay stops doubling here, so a permanent error (a wrong client secret) costs one call per row this often. */
export const REFRESH_RETRY_MAX_MS = 15 * 60 * 1000
/** The token endpoint is called from the Hub alarm; a request that hangs must not hold up the alarm's other work. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000

/** The delay before retrying a refresh that has failed `failures` times in a row (0 for the first failure). */
export const refreshRetryMs = (failures: number): number =>
  Math.min(REFRESH_RETRY_MS * 2 ** failures, REFRESH_RETRY_MAX_MS)

/**
 * When to refresh a token. Never earlier than one retry delay from `now`: a token living less than the margin would
 * otherwise be due on arrival and refresh in a loop.
 */
export const refreshDueAt = (refresh: OAuthRefresh, now: number): number =>
  Math.max(now + REFRESH_RETRY_MS, refresh.accessExpiresAt - REFRESH_MARGIN_MS)

export interface OAuthClient {
  readonly clientId: string
  readonly clientSecret: string
}

/** OAuth client credentials, or null when the provider is not configured on this Worker. */
export const oauthClient = (env: Env, provider: OAuthProvider): OAuthClient | null => {
  const clientId = env[provider.clientIdEnv]
  const clientSecret = env[provider.clientSecretEnv]
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** How an expiring access token is renewed. Epoch milliseconds. */
export interface OAuthRefresh {
  readonly token: string
  readonly accessExpiresAt: number
  readonly expiresAt: number
}

/** What a token endpoint granted. `refresh` is null when the access token does not expire. */
export interface OAuthGrant {
  readonly accessToken: string
  readonly refresh: OAuthRefresh | null
}

/** The provider refused the refresh token (expired, revoked, or already used): only a reconnect brings access back. */
export class RefreshRefused extends Error {}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0

/** POSTs a grant to the provider's token endpoint. GitHub answers errors with 200 and an `error` field. */
const requestGrant = async (
  provider: OAuthProvider,
  client: OAuthClient,
  params: Record<string, string>,
  now: number,
): Promise<OAuthGrant | { readonly error: string }> => {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "kestrel-control-plane",
    },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    return { error: String(body.error ?? res.status) }
  }
  const { refresh_token: token, expires_in: accessIn, refresh_token_expires_in: refreshIn } = body
  // A token without `expires_in` never expires (an OAuth app, or a GitHub App with expiration turned off).
  const refresh =
    typeof token === "string" && token.length > 0 && positive(accessIn) && positive(refreshIn)
      ? { token, accessExpiresAt: now + accessIn * 1000, expiresAt: now + refreshIn * 1000 }
      : null
  return { accessToken: body.access_token, refresh }
}

/** Exchanges an authorization code from the OAuth callback. */
export const exchangeCode = async (
  provider: OAuthProvider,
  client: OAuthClient,
  code: string,
  redirectUri: string,
  now = Date.now(),
): Promise<OAuthGrant> => {
  const grant = await requestGrant(provider, client, { code, redirect_uri: redirectUri }, now)
  if ("error" in grant) throw new UpstreamError(`${provider.label} token exchange failed: ${grant.error}`)
  return grant
}

/**
 * Trades a refresh token for a new access token and a new refresh token; the old refresh token is spent either way.
 * Throws `RefreshRefused` when the provider will never accept this refresh token, and anything else for a failure
 * worth retrying (network, outage, rate limit).
 */
export const refreshGrant = async (
  provider: OAuthProvider,
  client: OAuthClient,
  refreshToken: string,
  now = Date.now(),
): Promise<OAuthGrant> => {
  const grant = await requestGrant(provider, client, { grant_type: "refresh_token", refresh_token: refreshToken }, now)
  if (!("error" in grant)) return grant
  if (grant.error === "bad_refresh_token") throw new RefreshRefused(`${provider.label} refused the refresh token`)
  throw new UpstreamError(`${provider.label} token refresh failed: ${grant.error}`)
}

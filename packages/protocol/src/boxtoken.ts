/**
 * Box tokens: short-lived HS256 JWTs the control plane mints for a signed-in user and one of their own boxes
 * (`ControlPaths.boxToken`). The key is that box's secret, which only the control plane and the box hold, so the box
 * verifies tokens offline. Uses WebCrypto only (Workers and Bun); importing this module touches no crypto.
 */

export interface BoxTokenClaims {
  /** GitHub login of the user the token acts for (the box's owner). */
  readonly sub: string
  /** Id of the box the token is for. */
  readonly aud: string
  /** Issued at / expires, seconds since the epoch. */
  readonly iat: number
  readonly exp: number
  /** Version of the user's connections at mint time; the box refetches credentials when it changes. */
  readonly cv: string
  /** True only for sessions from `/auth/dev-login`. */
  readonly dev?: boolean
}

/** Lifetime of a minted box token. Clients refresh a minute or more before `exp`. */
export const BOX_TOKEN_TTL_SECONDS = 60 * 60

/** Query parameter carrying a box token where no header can be set (WebSockets, `<img>`). */
export const BOX_TOKEN_QUERY = "access_token"

const encoder = new TextEncoder()
/** base64url of `{"alg":"HS256","typ":"JWT"}`. */
const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

export async function signBoxToken(secret: string, claims: BoxTokenClaims): Promise<string> {
  const input = `${HEADER}.${base64url(encoder.encode(JSON.stringify(claims)))}`
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input))
  return `${input}.${base64url(new Uint8Array(signature))}`
}

/**
 * The token's claims when it is an HS256 token signed with `secret`, for box `boxId`, and not expired at `nowSeconds`;
 * otherwise null. The signature is checked (constant time, by WebCrypto) before the claims are read.
 */
export async function verifyBoxToken(
  secret: string,
  boxId: string,
  token: string,
  nowSeconds: number,
): Promise<BoxTokenClaims | null> {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts as [string, string, string]
  if (header !== HEADER) return null
  const sig = fromBase64url(signature)
  if (sig === null) return null
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
  const ok = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(`${header}.${payload}`))
  if (!ok) return null
  const body = fromBase64url(payload)
  if (body === null) return null
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return null
  }
  if (typeof claims !== "object" || claims === null) return null
  const c = claims as Record<string, unknown>
  if (typeof c.sub !== "string" || c.sub === "") return null
  if (c.aud !== boxId) return null
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || c.exp <= nowSeconds) return null
  if (typeof c.cv !== "string") return null
  if (c.dev !== undefined && typeof c.dev !== "boolean") return null
  return { sub: c.sub, aud: c.aud, iat: c.iat, exp: c.exp, cv: c.cv, ...(c.dev === true ? { dev: true } : {}) }
}

/**
 * Managed-box grants: short-lived ES256 JWTs the control plane signs for a signed-in user to use the managed agent box
 * directly (`ControlPaths.userBoxToken(MANAGED_BOX_ID)`). The control plane holds only the private JWK; the managed box
 * holds only the public JWK, so it verifies grants offline. Uses WebCrypto only (Workers, Bun and Node).
 */
import type { BoxTokenClaims } from "./boxtoken"

/** Box id the managed box is addressed by in the box-token routes; user box ids are UUIDs, so it cannot collide. */
export const MANAGED_BOX_ID = "managed"

/** Lifetime of a managed grant. Clients refresh before `exp`; the box closes WebSockets authenticated by it at `exp`. */
export const MANAGED_BOX_TOKEN_TTL_SECONDS = 15 * 60

/** Tolerated clock skew for `iat` in the future. */
const CLOCK_SKEW_SECONDS = 60

const encoder = new TextEncoder()
/** base64url of `{"alg":"ES256","typ":"JWT"}`; the only header a grant may carry. */
const HEADER = btoa(JSON.stringify({ alg: "ES256", typ: "JWT" }))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "")

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const

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

/**
 * Signs `claims` with the control plane's private P-256 key. `claims.aud` must be `MANAGED_BOX_ID`, and the lifetime
 * must not exceed `MANAGED_BOX_TOKEN_TTL_SECONDS`; both are programmer errors, so they throw.
 */
export async function signManagedBoxToken(privateJwk: JsonWebKey, claims: BoxTokenClaims): Promise<string> {
  if (claims.aud !== MANAGED_BOX_ID) throw new TypeError("managed box grants must be for the managed box")
  if (claims.exp - claims.iat > MANAGED_BOX_TOKEN_TTL_SECONDS) throw new RangeError("managed box grant lifetime too long")
  const input = `${HEADER}.${base64url(encoder.encode(JSON.stringify(claims)))}`
  const key = await crypto.subtle.importKey("jwk", privateJwk, ECDSA_P256, false, ["sign"])
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input))
  return `${input}.${base64url(new Uint8Array(signature))}`
}

/**
 * The grant's claims when it is a valid ES256 token signed by the private key of `publicJwk`, addressed to the managed
 * box, not expired at `nowSeconds`, and within the managed lifetime; otherwise null. Never throws: any malformed input,
 * unusable key or bad signature answers null. The signature is checked before the claims are read.
 */
export async function verifyManagedBoxToken(
  publicJwk: JsonWebKey,
  token: string,
  nowSeconds: number,
): Promise<BoxTokenClaims | null> {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const [header, payload, signature] = parts as [string, string, string]
    if (header !== HEADER) return null
    const sig = fromBase64url(signature)
    if (sig === null || sig.byteLength !== 64) return null
    // Only the public members: a JWK carrying `d` is a private key and must not be importable as a verifier.
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, ext: true },
      ECDSA_P256,
      false,
      ["verify"],
    )
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, encoder.encode(`${header}.${payload}`))
    if (!ok) return null
    const body = fromBase64url(payload)
    if (body === null) return null
    const claims: unknown = JSON.parse(new TextDecoder().decode(body))
    if (typeof claims !== "object" || claims === null) return null
    const c = claims as Record<string, unknown>
    if (typeof c.sub !== "string" || c.sub === "") return null
    if (c.aud !== MANAGED_BOX_ID) return null
    const { iat, exp } = c
    if (typeof iat !== "number" || typeof exp !== "number" || !Number.isFinite(iat) || !Number.isFinite(exp)) return null
    if (iat > nowSeconds + CLOCK_SKEW_SECONDS || exp <= nowSeconds) return null
    if (exp - iat <= 0 || exp - iat > MANAGED_BOX_TOKEN_TTL_SECONDS) return null
    if (typeof c.cv !== "string") return null
    if (c.dev !== undefined && typeof c.dev !== "boolean") return null
    return { sub: c.sub, aud: MANAGED_BOX_ID, iat, exp, cv: c.cv, ...(c.dev === true ? { dev: true } : {}) }
  } catch {
    return null
  }
}

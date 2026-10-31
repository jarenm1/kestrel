import { BoxUrl } from "@cloudagents/protocol"
import { Option, Schema } from "effect"
import type { Env } from "./env"

/** The managed box's origin, or null when unset or invalid. Null means unavailable; the Worker never relays instead. */
export const managedBoxUrl = (env: Env): string | null =>
  env.MANAGED_BOX_URL === undefined ? null : Option.getOrNull(Schema.decodeUnknownOption(BoxUrl)(env.MANAGED_BOX_URL))

const isP256PrivateJwk = (value: unknown): value is JsonWebKey & { x: string; y: string; d: string } =>
  typeof value === "object" &&
  value !== null &&
  "kty" in value &&
  value.kty === "EC" &&
  "crv" in value &&
  value.crv === "P-256" &&
  "x" in value &&
  typeof value.x === "string" &&
  "y" in value &&
  typeof value.y === "string" &&
  "d" in value &&
  typeof value.d === "string"

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const

/**
 * The managed grant signing key: the private P-256 JWK in `MANAGED_BOX_SIGNING_KEY`, checked to import as an ES256
 * signing key. Null when unset, malformed or unusable, and then the managed box is unavailable. The key is never
 * echoed or logged.
 */
export const managedSigningKey = async (env: Env): Promise<JsonWebKey | null> => {
  if (env.MANAGED_BOX_SIGNING_KEY === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(env.MANAGED_BOX_SIGNING_KEY)
  } catch {
    return null
  }
  if (!isP256PrivateJwk(parsed)) return null
  try {
    await crypto.subtle.importKey("jwk", parsed, ECDSA_P256, false, ["sign"])
  } catch {
    return null
  }
  return parsed
}

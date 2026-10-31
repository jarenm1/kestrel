import { describe, expect, test } from "bun:test"
import type { BoxTokenClaims } from "./src/boxtoken"
import {
  MANAGED_BOX_ID,
  MANAGED_BOX_TOKEN_TTL_SECONDS,
  signManagedBoxToken,
  verifyManagedBoxToken,
} from "./src/managedtoken"

const NOW = 1_800_000_000
const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const encodeJson = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)))

const ES256_HEADER = encodeJson({ alg: "ES256", typ: "JWT" })

async function keyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  return {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  }
}

/** Signs a JWS signing input directly with WebCrypto, so the rejection cases never depend on the code under test. */
async function signInput(privateJwk: JsonWebKey, input: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)))
}

/** A token assembled by hand: the header and payload are encoded as given, then signed with `privateJwk`. */
async function rawToken(privateJwk: JsonWebKey, header: string, payload: unknown): Promise<string> {
  const input = `${header}.${encodeJson(payload)}`
  return `${input}.${base64url(await signInput(privateJwk, input))}`
}

const grant = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: "octocat",
  aud: MANAGED_BOX_ID,
  iat: NOW,
  exp: NOW + 600,
  cv: "1",
  ...overrides,
})

function partsOf(token: string): { header: string; payload: string; signature: string } {
  const [header = "", payload = "", signature = ""] = token.split(".")
  return { header, payload, signature }
}

describe("managed grants verify only when signed by the control plane for the managed box", () => {
  test("a grant from signManagedBoxToken verifies to its claims", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const issued: BoxTokenClaims = { sub: "octocat", aud: MANAGED_BOX_ID, iat: NOW, exp: NOW + 600, cv: "1" }
    const token = await signManagedBoxToken(privateJwk, issued)
    expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toEqual(issued)
  })

  test("a hand-signed grant with the canonical header is accepted, so the rejections below are meaningful", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const token = await rawToken(privateJwk, ES256_HEADER, grant())
    expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toMatchObject({ sub: "octocat", aud: MANAGED_BOX_ID })
  })

  test("editing the claims without re-signing is rejected", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const { header, signature } = partsOf(await rawToken(privateJwk, ES256_HEADER, grant()))
    const forged = `${header}.${encodeJson(grant({ sub: "mallory" }))}.${signature}`
    expect(await verifyManagedBoxToken(publicJwk, forged, NOW)).toBeNull()
  })

  test("a flipped signature byte is rejected", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const { header, payload, signature } = partsOf(await rawToken(privateJwk, ES256_HEADER, grant()))
    // The first base64url character carries six bits of the first signature byte, so changing it changes the signature.
    const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`
    expect(await verifyManagedBoxToken(publicJwk, `${header}.${payload}.${flipped}`, NOW)).toBeNull()
  })

  test("a signature of the wrong length is rejected", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const input = `${ES256_HEADER}.${encodeJson(grant())}`
    const signature = await signInput(privateJwk, input)
    expect(await verifyManagedBoxToken(publicJwk, `${input}.${base64url(signature.slice(0, 63))}`, NOW)).toBeNull()
  })

  test("a grant signed by a different key is rejected", async () => {
    const issuer = await keyPair()
    const other = await keyPair()
    const token = await rawToken(issuer.privateJwk, ES256_HEADER, grant())
    expect(await verifyManagedBoxToken(other.publicJwk, token, NOW)).toBeNull()
  })

  test("an unusable verifier key answers null rather than throwing", async () => {
    const { privateJwk } = await keyPair()
    const token = await rawToken(privateJwk, ES256_HEADER, grant())
    expect(await verifyManagedBoxToken({ kty: "EC", crv: "P-256", x: "AAAA", y: "BBBB" }, token, NOW)).toBeNull()
  })

  const otherAudiences: [string, Record<string, unknown>][] = [
    ["another audience", { aud: "other-box" }],
    ["no audience", { aud: undefined }],
  ]
  test.each(otherAudiences)("a grant for %s is rejected", async (_label, overrides) => {
    const { privateJwk, publicJwk } = await keyPair()
    const token = await rawToken(privateJwk, ES256_HEADER, grant(overrides))
    expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toBeNull()
  })

  test("a header other than canonical ES256 is rejected, including unsigned tokens", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const unsigned = `${encodeJson({ alg: "none", typ: "JWT" })}.${encodeJson(grant())}.`
    expect(await verifyManagedBoxToken(publicJwk, unsigned, NOW)).toBeNull()
    for (const alg of ["ES384", "HS256"]) {
      const token = await rawToken(privateJwk, encodeJson({ alg, typ: "JWT" }), grant())
      expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toBeNull()
    }
  })

  test("a grant is rejected at its exp instant and accepted one second before", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const token = await rawToken(privateJwk, ES256_HEADER, grant({ iat: NOW - 600, exp: NOW }))
    expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toBeNull()
    expect(await verifyManagedBoxToken(publicJwk, token, NOW - 1)).toMatchObject({ exp: NOW })
  })

  test("a grant longer than the managed lifetime is rejected; the maximum lifetime is accepted", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const tooLong = await rawToken(
      privateJwk,
      ES256_HEADER,
      grant({ exp: NOW + MANAGED_BOX_TOKEN_TTL_SECONDS + 1 }),
    )
    expect(await verifyManagedBoxToken(publicJwk, tooLong, NOW)).toBeNull()
    const atMaximum = await rawToken(privateJwk, ES256_HEADER, grant({ exp: NOW + MANAGED_BOX_TOKEN_TTL_SECONDS }))
    expect(await verifyManagedBoxToken(publicJwk, atMaximum, NOW)).toMatchObject({
      exp: NOW + MANAGED_BOX_TOKEN_TTL_SECONDS,
    })
  })

  test("signManagedBoxToken refuses to mint a grant longer than the managed lifetime", async () => {
    const { privateJwk } = await keyPair()
    await expect(
      signManagedBoxToken(privateJwk, {
        sub: "octocat",
        aud: MANAGED_BOX_ID,
        iat: NOW,
        exp: NOW + MANAGED_BOX_TOKEN_TTL_SECONDS + 1,
        cv: "1",
      }),
    ).rejects.toThrow(RangeError)
  })

  test("an issue time ahead of the verifier clock is tolerated for 60 seconds only", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const withinSkew = await rawToken(privateJwk, ES256_HEADER, grant({ iat: NOW + 60, exp: NOW + 600 }))
    expect(await verifyManagedBoxToken(publicJwk, withinSkew, NOW)).not.toBeNull()
    const beyondSkew = await rawToken(privateJwk, ES256_HEADER, grant({ iat: NOW + 61, exp: NOW + 600 }))
    expect(await verifyManagedBoxToken(publicJwk, beyondSkew, NOW)).toBeNull()
  })

  const malformedClaims: [string, Record<string, unknown>][] = [
    ["a missing subject", { sub: undefined }],
    ["a non-string subject", { sub: 42 }],
    ["a non-string credentials version", { cv: 1 }],
    ["a non-boolean dev flag", { dev: "yes" }],
    ["a non-numeric expiry", { exp: "soon" }],
    ["a non-numeric issue time", { iat: "1800000000" }],
  ]
  test.each(malformedClaims)("a grant with %s is rejected", async (_label, overrides) => {
    const { privateJwk, publicJwk } = await keyPair()
    const token = await rawToken(privateJwk, ES256_HEADER, grant(overrides))
    expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toBeNull()
  })

  test("a payload that is not a JSON object is rejected", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const notJson = await rawToken(privateJwk, ES256_HEADER, "octocat")
    const input = `${ES256_HEADER}.${base64url(encoder.encode("not json"))}`
    const garbled = `${input}.${base64url(await signInput(privateJwk, input))}`
    expect(await verifyManagedBoxToken(publicJwk, notJson, NOW)).toBeNull()
    expect(await verifyManagedBoxToken(publicJwk, garbled, NOW)).toBeNull()
  })

  test("malformed token strings answer null rather than throwing", async () => {
    const { publicJwk } = await keyPair()
    for (const token of ["", "garbage", "a.b", "a.b.c.d", `${ES256_HEADER}..`]) {
      expect(await verifyManagedBoxToken(publicJwk, token, NOW)).toBeNull()
    }
  })
})

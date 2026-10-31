import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { BOX_USER_HEADER, MANAGED_BOX_ID, signManagedBoxToken } from "@cloudagents/protocol"
import type { DirectSettings } from "../config"
import type { CredentialStoreShape, UserCredentials } from "../credentials"
import { makeBoxAuth } from "./auth"

const memoryStore = () => {
  const byUser = new Map<string, UserCredentials>()
  const store: CredentialStoreShape = {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
  return { store, byUser }
}

/** A control plane that answers `/box/credentials` for whichever owner the service request names. */
const controlPlane = (ownerFor: (user: string) => string) => {
  const asked: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const user = headers.get(BOX_USER_HEADER) ?? ""
    asked.push(`${String(input)} ${user} ${headers.get("authorization")}`)
    const owner = ownerFor(user)
    return new Response(
      JSON.stringify({ owner, credentialsVersion: "1", github: `${owner}-gh` }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as unknown as typeof fetch
  return { fetchFn, asked }
}

const keyPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  return {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  }
}

const grantFor = (privateJwk: JsonWebKey, sub: string) => {
  const now = Math.floor(Date.now() / 1000)
  return signManagedBoxToken(privateJwk, { sub, aud: MANAGED_BOX_ID, iat: now, exp: now + 900, cv: "1" })
}

describe("managed box grants", () => {
  test("each owner's grant resolves to that owner's credentials only", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const settings: DirectSettings = {
      mode: "managed",
      controlUrl: "https://control.example",
      boxToken: "service-token",
      publicKey: publicJwk,
    }
    const { store, byUser } = memoryStore()
    const { fetchFn, asked } = controlPlane((user) => user)
    const auth = makeBoxAuth(settings, store, fetchFn)

    const alice = await Effect.runPromise(Effect.either(auth.authenticate(await grantFor(privateJwk, "alice"))))
    const bob = await Effect.runPromise(Effect.either(auth.authenticate(await grantFor(privateJwk, "bob"))))
    expect(Either.isRight(alice) && alice.right.sub).toBe("alice")
    expect(Either.isRight(bob) && bob.right.sub).toBe("bob")

    expect(byUser.get("alice")?.github).toBe("alice-gh")
    expect(byUser.get("bob")?.github).toBe("bob-gh")
    await Effect.runPromise(auth.authenticate(await grantFor(privateJwk, "alice")))
    await Effect.runPromise(auth.authenticate(await grantFor(privateJwk, "bob")))
    expect(asked).toHaveLength(2)
  })

  test("a grant is refused when the control plane answers for another owner", async () => {
    const { privateJwk, publicJwk } = await keyPair()
    const settings: DirectSettings = {
      mode: "managed",
      controlUrl: "https://control.example",
      boxToken: "service-token",
      publicKey: publicJwk,
    }
    const { store, byUser } = memoryStore()
    const { fetchFn } = controlPlane(() => "bob")
    const auth = makeBoxAuth(settings, store, fetchFn)

    const outcome = await Effect.runPromise(Effect.either(auth.authenticate(await grantFor(privateJwk, "alice"))))
    expect(Either.isLeft(outcome) && outcome.left._tag).toBe("Unauthorized")
    expect(byUser.has("alice")).toBe(false)
    expect(byUser.has("bob")).toBe(false)
  })
})

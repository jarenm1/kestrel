import { describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { BOX_ID_HEADER, BOX_USER_HEADER, type BoxTokenClaims, signBoxToken } from "@cloudagents/protocol"
import type { RelayCredentials } from "@cloudagents/protocol"
import type { CredentialStoreShape } from "../credentials"
import { type BoxAuth, makeBoxAuth, type DirectSettings } from "./auth"
import type { BoxActivitySink } from "./box-activity"

const CONTROL = "https://control.example"
const BOX_ID = "box_fleet_1"
const SECRET = "fleet-box-secret"

const memoryStore = (): CredentialStoreShape => {
  const byUser = new Map<string, RelayCredentials>()
  return {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
}

interface Call {
  readonly url: string
  readonly headers: Record<string, string>
}

/** A control plane stub: answers each request with the next reply, and records what the box sent. */
const stubControl = (replies: Array<{ status: number; body?: unknown }>) => {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? { status: 500 }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const tokenFor = (sub: string, cv: string, iat = Math.floor(Date.now() / 1000), boxId = BOX_ID): Promise<string> => {
  const claims: BoxTokenClaims = { sub, aud: boxId, iat, exp: iat + 600, cv }
  return signBoxToken(SECRET, claims)
}

const managed: DirectSettings = { controlUrl: CONTROL, boxId: BOX_ID, boxSecret: SECRET, managed: true }
const byo: DirectSettings = { ...managed, managed: false }

const authenticate = (auth: BoxAuth, token: string) =>
  Effect.runPromise(Effect.either(auth.authenticate(token)))

const failureTag = (result: Either.Either<unknown, { readonly _tag: string }>) =>
  Either.isLeft(result) ? result.left._tag : "authenticated"

describe("managed box credentials", () => {
  test("asks for the token's user with the box's own secret and id", async () => {
    const { fetchFn, calls } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1", github: "gh-a" } }])
    const store = memoryStore()
    const auth = makeBoxAuth(managed, store, fetchFn)

    const result = await authenticate(auth, await tokenFor("alice", "1"))

    expect(Either.isRight(result)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${CONTROL}/box/credentials`)
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(calls[0]?.headers[BOX_ID_HEADER]).toBe(BOX_ID)
    expect(calls[0]?.headers[BOX_USER_HEADER]).toBe("alice")
    expect(await Effect.runPromise(store.get("alice"))).toMatchObject({ user: "alice", github: "gh-a" })
  })

  test("each user's credentials are fetched for that user only", async () => {
    const { fetchFn, calls } = stubControl([
      { status: 200, body: { owner: "alice", credentialsVersion: "1" } },
      { status: 200, body: { owner: "bob", credentialsVersion: "1" } },
    ])
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn)

    await authenticate(auth, await tokenFor("alice", "1"))
    await authenticate(auth, await tokenFor("bob", "1"))

    expect(calls.map((call) => call.headers[BOX_USER_HEADER])).toEqual(["alice", "bob"])
  })

  test("a user not assigned to this box is refused", async () => {
    const { fetchFn } = stubControl([{ status: 403 }])
    const store = memoryStore()
    const auth = makeBoxAuth(managed, store, fetchFn)

    const result = await authenticate(auth, await tokenFor("mallory", "1"))

    expect(failureTag(result)).toBe("Unauthorized")
    expect(await Effect.runPromise(store.get("mallory"))).toBeNull()
  })

  test("other control plane failures are unavailable, not unauthorized", async () => {
    const { fetchFn } = stubControl([{ status: 500 }])
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn)

    const result = await authenticate(auth, await tokenFor("alice", "1"))

    expect(failureTag(result)).toBe("Unavailable")
  })

  test("a token for another box is refused without asking the control plane", async () => {
    const { fetchFn, calls } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1" } }])
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn)

    const result = await authenticate(auth, await tokenFor("alice", "1", undefined, "box_other"))

    expect(failureTag(result)).toBe("Unauthorized")
    expect(calls).toHaveLength(0)
  })

  test("credentials are refetched only when the token's version changes", async () => {
    const { fetchFn, calls } = stubControl([
      { status: 200, body: { owner: "alice", credentialsVersion: "1" } },
      { status: 200, body: { owner: "alice", credentialsVersion: "2" } },
    ])
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn)
    const now = Math.floor(Date.now() / 1000)

    await authenticate(auth, await tokenFor("alice", "1", now))
    await authenticate(auth, await tokenFor("alice", "1", now))
    expect(calls).toHaveLength(1)

    await authenticate(auth, await tokenFor("alice", "2", now))
    expect(calls).toHaveLength(2)
  })
})

describe("managed box activity", () => {
  const activityLog = () => {
    const logins: string[] = []
    const activity: BoxActivitySink = { record: (login) => void logins.push(login) }
    return { logins, activity }
  }

  test("each request that fully authenticated records its login", async () => {
    const { fetchFn } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1" } }])
    const { logins, activity } = activityLog()
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn, activity)
    const token = await tokenFor("alice", "1")

    await authenticate(auth, token)
    await authenticate(auth, token)

    expect(logins).toEqual(["alice", "alice"])
  })

  test("a token the box refuses is not activity", async () => {
    const { fetchFn, calls } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1" } }])
    const { logins, activity } = activityLog()
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn, activity)

    const result = await authenticate(auth, "not-a-box-token")

    expect(failureTag(result)).toBe("Unauthorized")
    expect(calls).toHaveLength(0)
    expect(logins).toEqual([])
  })

  test("a user not assigned to this box is not activity", async () => {
    const { fetchFn } = stubControl([{ status: 403 }])
    const { logins, activity } = activityLog()
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn, activity)

    const result = await authenticate(auth, await tokenFor("mallory", "1"))

    expect(failureTag(result)).toBe("Unauthorized")
    expect(logins).toEqual([])
  })

  test("a request whose credentials could not be refreshed is not activity", async () => {
    const { fetchFn } = stubControl([{ status: 500 }])
    const { logins, activity } = activityLog()
    const auth = makeBoxAuth(managed, memoryStore(), fetchFn, activity)

    const result = await authenticate(auth, await tokenFor("alice", "1"))

    expect(failureTag(result)).toBe("Unavailable")
    expect(logins).toEqual([])
  })

  test("a user's own box reports no activity", async () => {
    const { fetchFn } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1" } }])
    const { logins, activity } = activityLog()
    const auth = makeBoxAuth(byo, memoryStore(), fetchFn, activity)

    const result = await authenticate(auth, await tokenFor("alice", "1"))

    expect(Either.isRight(result)).toBe(true)
    expect(logins).toEqual([])
  })
})

describe("a user's own box", () => {
  test("asks /box/self for its owner, without a user header", async () => {
    const { fetchFn, calls } = stubControl([{ status: 200, body: { owner: "alice", credentialsVersion: "1" } }])
    const auth = makeBoxAuth(byo, memoryStore(), fetchFn)

    const result = await authenticate(auth, await tokenFor("alice", "1"))

    expect(Either.isRight(result)).toBe(true)
    expect(calls[0]?.url).toBe(`${CONTROL}/box/self`)
    expect(calls[0]?.headers[BOX_USER_HEADER]).toBeUndefined()
  })
})

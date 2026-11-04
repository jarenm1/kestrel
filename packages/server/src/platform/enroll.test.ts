import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Either } from "effect"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureNestSecret } from "./enroll"
import { readStoredSecret, storedSecretPath, writeStoredSecret } from "./secret"

type Reply = { readonly status: number; readonly body: unknown }
type Seen = { readonly path: string; readonly body: unknown }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const dataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "enroll-test-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A control plane that answers each request with the next reply; the last reply repeats. */
const controlPlane = (replies: readonly Reply[]) => {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const reply = replies[Math.min(seen.length, replies.length - 1)]
      if (reply === undefined) throw new Error("the fake control plane has no reply scripted")
      seen.push({ path: new URL(request.url).pathname, body: await request.json().catch(() => null) })
      return Response.json(reply.body, { status: reply.status })
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
  })
  return { seen, url: `http://127.0.0.1:${server.port}` }
}

const enrollEnv = (controlUrl: string): Record<string, string> => ({
  CLOUDAGENTS_NEST_ENROLL_TOKEN: "one-time-token",
  CLOUDAGENTS_BOX_ID: "box_1",
  CLOUDAGENTS_CONTROL_URL: controlUrl,
})

const run = (env: Record<string, string | undefined>, dir: string) =>
  Effect.runPromise(Effect.either(ensureNestSecret(env, dir)))

describe("ensureNestSecret", () => {
  test("a stored secret wins: no enrollment request is made", async () => {
    const dir = await dataDir()
    writeStoredSecret(dir, "earlier-secret")
    const plane = controlPlane([{ status: 200, body: { secret: "new-secret" } }])

    expect(Either.isRight(await run(enrollEnv(plane.url), dir))).toBe(true)
    expect(plane.seen).toHaveLength(0)
    expect(readStoredSecret(dir)).toBe("earlier-secret")
  })

  test("a box secret from the environment wins: no request, nothing stored", async () => {
    const dir = await dataDir()
    const plane = controlPlane([{ status: 200, body: { secret: "new-secret" } }])
    const env = { ...enrollEnv(plane.url), CLOUDAGENTS_BOX_SECRET: "env-secret" }

    expect(Either.isRight(await run(env, dir))).toBe(true)
    expect(plane.seen).toHaveLength(0)
    expect(readStoredSecret(dir)).toBeNull()
  })

  test("a token is exchanged once: the secret is stored owner-only and the token is not spent twice", async () => {
    const dir = await dataDir()
    const plane = controlPlane([{ status: 200, body: { secret: "s3cret-value" } }])

    expect(Either.isRight(await run(enrollEnv(plane.url), dir))).toBe(true)
    expect(plane.seen).toEqual([{ path: "/box/nest/enroll", body: { boxId: "box_1", token: "one-time-token" } }])
    expect(readStoredSecret(dir)).toBe("s3cret-value")
    expect((await stat(storedSecretPath(dir))).mode & 0o777).toBe(0o600)

    expect(Either.isRight(await run(enrollEnv(plane.url), dir))).toBe(true)
    expect(plane.seen).toHaveLength(1)
  })

  test("a refusal fails at once, and the error never carries the token", async () => {
    const dir = await dataDir()
    const plane = controlPlane([{ status: 403, body: { error: "token already used" } }])

    const result = await run(enrollEnv(plane.url), dir)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isRight(result)) return
    expect(result.left.message).toContain("HTTP 403")
    expect(result.left.message).not.toContain("one-time-token")
    expect(plane.seen).toHaveLength(1)
    expect(readStoredSecret(dir)).toBeNull()
  })

  // Real-time exception: the production retry backoff (1 s) is what this test exercises; the wait is that backoff.
  test("a server error is retried until the control plane answers", async () => {
    const dir = await dataDir()
    const plane = controlPlane([
      { status: 503, body: { error: "busy" } },
      { status: 200, body: { secret: "after-retry" } },
    ])

    expect(Either.isRight(await run(enrollEnv(plane.url), dir))).toBe(true)
    expect(plane.seen).toHaveLength(2)
    expect(readStoredSecret(dir)).toBe("after-retry")
  })

  test("an unreadable enrollment result is refused", async () => {
    const dir = await dataDir()
    const plane = controlPlane([{ status: 200, body: { wrong: true } }])

    const result = await run(enrollEnv(plane.url), dir)
    expect(Either.isLeft(result)).toBe(true)
    expect(readStoredSecret(dir)).toBeNull()
  })

  test("a token without a box id fails before any request", async () => {
    const dir = await dataDir()
    const plane = controlPlane([{ status: 200, body: { secret: "unused" } }])
    const env = { CLOUDAGENTS_NEST_ENROLL_TOKEN: "one-time-token", CLOUDAGENTS_CONTROL_URL: plane.url }

    expect(Either.isLeft(await run(env, dir))).toBe(true)
    expect(plane.seen).toHaveLength(0)
  })
})

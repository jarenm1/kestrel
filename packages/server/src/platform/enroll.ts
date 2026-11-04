import { Data, Effect, Either, Schema } from "effect"
import { ControlPaths, NestEnrollResult } from "@cloudagents/protocol"
import { controlBase } from "../control/client"
import { readStoredSecret, writeStoredSecret } from "./secret"

export class EnrollError extends Data.TaggedError("EnrollError")<{ readonly message: string }> {}

type Env = Readonly<Record<string, string | undefined>>

/** Attempts for network failures and 5xx answers; a refusal (4xx) is final at once. */
const MAX_ATTEMPTS = 5
const FIRST_BACKOFF_MS = 1_000
const REQUEST_TIMEOUT_MS = 15_000

type Attempt =
  | { readonly _tag: "ok"; readonly secret: string }
  | { readonly _tag: "retry"; readonly message: string }
  | { readonly _tag: "refused"; readonly message: string }

/** One POST. The token is sent in the body only and never placed in a message. */
const postOnce = async (url: string, boxId: string, token: string): Promise<Attempt> => {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boxId, token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    return { _tag: "retry", message: "control plane unreachable" }
  }
  if (response.status >= 500) {
    return { _tag: "retry", message: `control plane failed to enroll the box (HTTP ${response.status})` }
  }
  if (!response.ok) {
    return { _tag: "refused", message: `control plane refused enrollment (HTTP ${response.status})` }
  }
  const body: unknown = await response.json().catch(() => null)
  const parsed = Schema.decodeUnknownEither(NestEnrollResult)(body)
  if (Either.isLeft(parsed)) return { _tag: "refused", message: "control plane sent an unreadable enrollment result" }
  return { _tag: "ok", secret: parsed.right.secret }
}

const enrollWithRetry = (url: string, boxId: string, token: string): Effect.Effect<string, EnrollError> =>
  Effect.gen(function* () {
    let backoff = FIRST_BACKOFF_MS
    for (let attempt = 1; ; attempt++) {
      const result = yield* Effect.promise(() => postOnce(url, boxId, token))
      if (result._tag === "ok") return result.secret
      if (result._tag === "refused" || attempt === MAX_ATTEMPTS) {
        return yield* Effect.fail(new EnrollError({ message: result.message }))
      }
      yield* Effect.logWarning(`${result.message}; retrying enrollment in ${backoff} ms`)
      yield* Effect.sleep(backoff)
      backoff *= 2
    }
  })

/**
 * A Nest box's first start. Precedence, so a restarted box never spends its token twice:
 * 1. `CLOUDAGENTS_BOX_SECRET` set (a box the user runs with its own secret): nothing to do.
 * 2. A stored secret in the data dir (an earlier enrollment): nothing to do.
 * 3. `CLOUDAGENTS_NEST_ENROLL_TOKEN` set: exchange it once for the secret and store it, owner-only.
 * Without a token and without a secret the box runs as a plain box with no direct mode.
 */
export const ensureNestSecret = (env: Env, dataDir: string): Effect.Effect<void, EnrollError> =>
  Effect.suspend(() => {
    const token = env.CLOUDAGENTS_NEST_ENROLL_TOKEN?.trim() ?? ""
    if (token === "") return Effect.void
    if ((env.CLOUDAGENTS_BOX_SECRET?.trim() ?? "") !== "") return Effect.void
    if (readStoredSecret(dataDir) !== null) return Effect.void
    const boxId = env.CLOUDAGENTS_BOX_ID?.trim() ?? ""
    const controlUrl = env.CLOUDAGENTS_CONTROL_URL?.trim() ?? ""
    if (boxId === "" || controlUrl === "") {
      return Effect.fail(
        new EnrollError({ message: "enrolling a Nest box needs CLOUDAGENTS_BOX_ID and CLOUDAGENTS_CONTROL_URL" }),
      )
    }
    const url = `${controlBase(controlUrl)}${ControlPaths.nestEnroll}`
    return enrollWithRetry(url, boxId, token).pipe(
      Effect.flatMap((secret) =>
        Effect.try({
          try: () => writeStoredSecret(dataDir, secret),
          catch: () => new EnrollError({ message: "enrolled, but the box secret could not be stored" }),
        }),
      ),
      Effect.tap(() => Effect.logInfo("nest box enrolled; secret stored in the data dir")),
    )
  })

import { Data, Effect, Either, Schema } from "effect"
import {
  BOX_ID_HEADER,
  BoxSelf,
  type BoxTokenClaims,
  ControlPaths,
  type RelayCredentials,
  verifyBoxToken,
} from "@cloudagents/protocol"
import { controlBase } from "../control/client"
import type { CredentialStoreShape } from "../credentials"

/** The token is missing, malformed, expired, for another box, or for a user who does not own this box. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly message: string }> {}

/** The control plane could not give the box its owner's credentials. */
export class Unavailable extends Data.TaggedError("Unavailable")<{ readonly message: string }> {}

export interface DirectSettings {
  readonly controlUrl: string
  readonly boxId: string
  readonly boxSecret: string
}

export interface BoxAuth {
  /**
   * Claims of a valid box token. When it returns, the token's user's credentials are current in the store:
   * fetched from `/box/self` on first use and whenever the token's `cv` differs from the version last absorbed.
   */
  readonly authenticate: (token: string) => Effect.Effect<BoxTokenClaims, Unauthorized | Unavailable>
}

const CONTROL_TIMEOUT_MS = 15_000

const INVALID_ANSWER = "control plane gave an unexpected answer for the box's credentials"

export const makeBoxAuth = (
  settings: DirectSettings,
  store: CredentialStoreShape,
  fetchFn: typeof fetch = fetch,
): BoxAuth => {
  const base = controlBase(settings.controlUrl)
  // Per user: the credentials version last absorbed and when (seconds) its fetch started. A token refetches only when
  // it carries another version and was minted after that fetch began; older tokens cannot know anything newer, and
  // two clients holding tokens of different ages would otherwise make the box refetch on every alternating request.
  const absorbed = new Map<string, { readonly cv: string; readonly at: number }>()
  // One fetch per user and version at a time; concurrent requests share it.
  const inFlight = new Map<string, Promise<void>>()

  const fetchCredentials = async (claims: BoxTokenClaims): Promise<void> => {
    const at = Math.floor(Date.now() / 1000)
    let response: Response
    try {
      response = await fetchFn(`${base}${ControlPaths.boxSelf}`, {
        headers: { authorization: `Bearer ${settings.boxSecret}`, [BOX_ID_HEADER]: settings.boxId },
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      throw new Unavailable({ message: "control plane unreachable" })
    }
    if (!response.ok) {
      throw new Unavailable({ message: `control plane answered ${response.status} for the box's credentials` })
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Unavailable({ message: INVALID_ANSWER })
    }
    const decoded = Schema.decodeUnknownEither(BoxSelf)(body)
    if (Either.isLeft(decoded)) throw new Unavailable({ message: INVALID_ANSWER })
    const self = decoded.right
    if (self.owner !== claims.sub) throw new Unauthorized({ message: "token is not for this box's owner" })
    const creds: RelayCredentials = {
      user: self.owner,
      github: self.github,
      anthropic: self.anthropic,
      openai: self.openai,
      ...(claims.dev === true ? { dev: true } : {}),
    }
    await Effect.runPromise(store.set(creds))
    absorbed.set(self.owner, { cv: self.credentialsVersion, at })
  }

  const absorb = (claims: BoxTokenClaims): Promise<void> => {
    const key = `${claims.sub}\n${claims.cv}`
    const pending = inFlight.get(key)
    if (pending !== undefined) return pending
    const started = fetchCredentials(claims).finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }

  const authenticate = (token: string): Effect.Effect<BoxTokenClaims, Unauthorized | Unavailable> =>
    Effect.gen(function* () {
      const claims = yield* Effect.promise(() =>
        verifyBoxToken(settings.boxSecret, settings.boxId, token, Math.floor(Date.now() / 1000)),
      )
      if (claims === null) return yield* Effect.fail(new Unauthorized({ message: "invalid or expired box token" }))
      const cached = yield* store.get(claims.sub)
      const last = absorbed.get(claims.sub)
      if (cached === null || last === undefined || (claims.cv !== last.cv && claims.iat >= last.at)) {
        yield* Effect.tryPromise({
          try: () => absorb(claims),
          catch: (error) =>
            error instanceof Unauthorized || error instanceof Unavailable
              ? error
              : new Unavailable({ message: "control plane unreachable" }),
        })
      }
      return claims
    })

  return { authenticate }
}

import { Data, Effect, Either, Schema } from "effect"
import {
  BOX_ID_HEADER,
  BOX_USER_HEADER,
  BoxSelf,
  type BoxTokenClaims,
  ControlPaths,
  type RelayCredentials,
  verifyBoxToken,
} from "@cloudagents/protocol"
import { controlBase } from "../control/client"
import type { CredentialStoreShape } from "../credentials"
import type { BoxActivitySink } from "./box-activity"

/**
 * The token is missing, malformed, expired, for another box, or for a user who does not own this box (for a managed
 * box: who is not assigned to it).
 */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly message: string }> {}

/** The control plane could not give the box its owner's credentials. */
export class Unavailable extends Data.TaggedError("Unavailable")<{ readonly message: string }> {}

/** The control plane could not be reached or answered with a server error: an outage, not a refusal. */
class ControlOutage extends Data.TaggedError("ControlOutage")<{ readonly message: string }> {}

export interface BoxAuthentication {
  readonly claims: BoxTokenClaims
  /**
   * True when the control plane is in an outage and this box holds no credentials for the token's user, so the
   * request may only do what `direct/listener.ts` allows offline. Only a user's own box is ever offline.
   */
  readonly offline: boolean
}

export interface DirectSettings {
  readonly controlUrl: string
  readonly boxId: string
  readonly boxSecret: string
  /** A Kestrel fleet box serving many users: its credentials come from `/box/credentials`, per user. */
  readonly managed: boolean
}

export interface BoxAuth {
  /**
   * Claims of a valid box token. Unless `offline`, the token's user's credentials are current in the store: fetched from
   * the control plane (`/box/self` for a user's own box, `/box/credentials` for a managed box) on first use and whenever
   * the token's `cv` differs from the version last absorbed.
   */
  readonly authenticate: (token: string) => Effect.Effect<BoxAuthentication, Unauthorized | Unavailable>
}

const CONTROL_TIMEOUT_MS = 15_000

const INVALID_ANSWER = "control plane gave an unexpected answer for the box's credentials"

export const makeBoxAuth = (
  settings: DirectSettings,
  store: CredentialStoreShape,
  fetchFn: typeof fetch = fetch,
  /** Told about each login whose request fully authenticated, so a managed box can report active users. */
  activity?: BoxActivitySink,
): BoxAuth => {
  const base = controlBase(settings.controlUrl)
  // Per user: the credentials version last absorbed and when (seconds) its fetch started. A token refetches only when
  // it carries another version and was minted after that fetch began; older tokens cannot know anything newer, and
  // two clients holding tokens of different ages would otherwise make the box refetch on every alternating request.
  const absorbed = new Map<string, { readonly cv: string; readonly at: number }>()
  // One fetch per user and version at a time; concurrent requests share it.
  const inFlight = new Map<string, Promise<void>>()
  // Users whose requests this box is serving offline, so the transition is logged once rather than on every request.
  const offlineUsers = new Set<string>()

  const fetchCredentials = async (claims: BoxTokenClaims): Promise<void> => {
    const at = Math.floor(Date.now() / 1000)
    const path = settings.managed ? ControlPaths.boxCredentials : ControlPaths.boxSelf
    const headers: Record<string, string> = { authorization: `Bearer ${settings.boxSecret}`, [BOX_ID_HEADER]: settings.boxId }
    // A managed box names the user it wants credentials for; the control plane answers only for users assigned to it.
    if (settings.managed) headers[BOX_USER_HEADER] = claims.sub
    let response: Response
    try {
      response = await fetchFn(`${base}${path}`, { headers, signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) })
    } catch {
      throw new ControlOutage({ message: "control plane unreachable" })
    }
    if (settings.managed && response.status === 403) {
      throw new Unauthorized({ message: "user is not assigned to this managed box" })
    }
    if (response.status >= 500) {
      throw new ControlOutage({ message: `control plane answered ${response.status} for the box's credentials` })
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
      providers: {
        ...self.providers,
        ...(self.anthropic === undefined ? {} : { anthropic: self.anthropic }),
        ...(self.openai === undefined ? {} : { openai: self.openai }),
      },
      anthropic: self.anthropic,
      openai: self.openai,
      ...(claims.dev === true ? { dev: true } : {}),
    }
    await Effect.runPromise(store.set(creds))
    absorbed.set(self.owner, { cv: self.credentialsVersion, at })
    if (offlineUsers.delete(self.owner)) {
      await Effect.runPromise(Effect.logInfo(`control plane reachable again: credentials restored for ${self.owner}`))
    }
  }

  const absorb = (claims: BoxTokenClaims): Promise<void> => {
    const key = `${claims.sub}\n${claims.cv}`
    const pending = inFlight.get(key)
    if (pending !== undefined) return pending
    const started = fetchCredentials(claims).finally(() => inFlight.delete(key))
    inFlight.set(key, started)
    return started
  }

  const authenticate = (token: string): Effect.Effect<BoxAuthentication, Unauthorized | Unavailable> =>
    Effect.gen(function* () {
      const claims = yield* Effect.promise(() =>
        verifyBoxToken(settings.boxSecret, settings.boxId, token, Math.floor(Date.now() / 1000)),
      )
      if (claims === null) return yield* Effect.fail(new Unauthorized({ message: "invalid or expired box token" }))
      const cached = yield* store.get(claims.sub)
      const last = absorbed.get(claims.sub)
      let offline = false
      if (cached === null || last === undefined || (claims.cv !== last.cv && claims.iat >= last.at)) {
        const outcome = yield* Effect.either(
          Effect.tryPromise({
            try: () => absorb(claims),
            catch: (error) =>
              error instanceof Unauthorized || error instanceof Unavailable || error instanceof ControlOutage
                ? error
                : new Unavailable({ message: "control plane unreachable" }),
          }),
        )
        if (Either.isLeft(outcome)) {
          const failure = outcome.left
          // Only an outage of a user's own box, with no credentials held for its owner, lets reads go on. Anything else,
          // including a refusal (401/403) from the control plane, stays a failure.
          if (failure._tag !== "ControlOutage" || cached !== null || settings.managed) {
            return yield* Effect.fail(failure._tag === "ControlOutage" ? new Unavailable({ message: failure.message }) : failure)
          }
          offline = true
          if (!offlineUsers.has(claims.sub)) {
            offlineUsers.add(claims.sub)
            yield* Effect.logWarning(
              `control plane unreachable: serving offline thread reads for ${claims.sub} until its credentials return`,
            )
          }
        }
      }
      // Only a fully authenticated request counts as activity, and only on a managed box: a user's own box reports to
      // nobody. The sink is synchronous and does no I/O, so it cannot delay or fail the authentication.
      if (settings.managed) {
        try {
          activity?.record(claims.sub)
        } catch {
          // Telemetry is best effort.
        }
      }
      return { claims, offline }
    })

  return { authenticate }
}

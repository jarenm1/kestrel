import { Data, Effect, Schema } from "effect"
import {
  Automation,
  BOX_USER_HEADER,
  ControlPaths,
  type CreateAutomationBody,
  type UpdateAutomationBody,
} from "@cloudagents/protocol"

/** The control plane refused or failed a call. `message` is the control plane's own message, shown to the agent as is. */
export class ControlError extends Data.TaggedError("ControlError")<{ readonly message: string }> {}

export interface ControlConfig {
  readonly controlUrl: string
  readonly boxToken: string
}

/** The automations the box may manage for one user. Every call acts for `user`; the control plane enforces ownership. */
export interface ControlClient {
  readonly list: (user: string) => Effect.Effect<ReadonlyArray<Automation>, ControlError>
  readonly get: (user: string, id: string) => Effect.Effect<Automation, ControlError>
  readonly create: (user: string, body: CreateAutomationBody) => Effect.Effect<Automation, ControlError>
  readonly update: (user: string, id: string, body: UpdateAutomationBody) => Effect.Effect<Automation, ControlError>
  readonly remove: (user: string, id: string) => Effect.Effect<void, ControlError>
}

const TIMEOUT_MS = 15_000
const INVALID_ANSWER = "control plane sent an unexpected answer"

/** The control plane over HTTP(S): the scheme of the relay URL swapped, origin and base path kept, trailing slashes dropped. */
const controlBase = (controlUrl: string): string => {
  const url = new URL(controlUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

const errorMessage = (text: string): string | null => {
  try {
    const body: unknown = JSON.parse(text)
    return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
      ? body.message
      : null
  } catch {
    return null
  }
}

const attempt = <A>(run: () => Promise<A>, message: string): Effect.Effect<A, ControlError> =>
  Effect.tryPromise({ try: run, catch: () => new ControlError({ message }) })

export const makeControlClient = (config: ControlConfig): ControlClient => {
  const base = controlBase(config.controlUrl)

  // Every call is authenticated as the box, and names the user it acts for in BOX_USER_HEADER.
  const call = (user: string, method: string, path: string, body?: unknown): Effect.Effect<unknown, ControlError> =>
    Effect.gen(function* () {
      const response = yield* attempt(
        () =>
          fetch(`${base}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${config.boxToken}`,
              [BOX_USER_HEADER]: user,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        "control plane unreachable",
      )
      if (!response.ok) {
        const text = yield* attempt(() => response.text(), "control plane failed")
        return yield* Effect.fail(
          new ControlError({ message: errorMessage(text) ?? `control plane answered ${response.status}` }),
        )
      }
      if (response.status === 204) return undefined
      return yield* attempt(() => response.json(), INVALID_ANSWER)
    })

  const decodeAutomation = (value: unknown): Effect.Effect<Automation, ControlError> =>
    Schema.decodeUnknown(Automation)(value).pipe(Effect.mapError(() => new ControlError({ message: INVALID_ANSWER })))

  return {
    list: (user) =>
      call(user, "GET", ControlPaths.boxAutomations).pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknown(Schema.Array(Automation))(value).pipe(
            Effect.mapError(() => new ControlError({ message: INVALID_ANSWER })),
          ),
        ),
      ),
    get: (user, id) => call(user, "GET", ControlPaths.boxAutomation(id)).pipe(Effect.flatMap(decodeAutomation)),
    create: (user, body) => call(user, "POST", ControlPaths.boxAutomations, body).pipe(Effect.flatMap(decodeAutomation)),
    update: (user, id, body) =>
      call(user, "PATCH", ControlPaths.boxAutomation(id), body).pipe(Effect.flatMap(decodeAutomation)),
    remove: (user, id) => call(user, "DELETE", ControlPaths.boxAutomation(id)).pipe(Effect.asVoid),
  }
}

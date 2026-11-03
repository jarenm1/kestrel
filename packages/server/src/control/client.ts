import { Data, Effect, Schema } from "effect"
import {
  Automation,
  BOX_ID_HEADER,
  BOX_USER_HEADER,
  ControlPaths,
  type CreateAutomationBody,
  type ToolFailureReport,
  type UpdateAutomationBody,
} from "@cloudagents/protocol"
import type { ServerConfig } from "../config"

/** The control plane refused or failed a call. `message` is the control plane's own message, shown to the agent as is. */
export class ControlError extends Data.TaggedError("ControlError")<{ readonly message: string }> {}

/** Who the box is to the control plane: the relayed box with the relay's token, or a managed box with its secret. */
export type ControlConfig =
  | { readonly controlUrl: string; readonly boxToken: string }
  | { readonly controlUrl: string; readonly boxId: string; readonly boxSecret: string }

/**
 * The automations the box may manage for one user, where every call acts for `user` and the control plane enforces
 * ownership, and the box's own tool failure counts.
 */
export interface ControlClient {
  readonly watchPr: (user: string, taskId: string, repo: string, number: number) => Effect.Effect<void, ControlError>
  readonly unwatchPr: (user: string, taskId: string) => Effect.Effect<void, ControlError>
  readonly list: (user: string) => Effect.Effect<ReadonlyArray<Automation>, ControlError>
  readonly get: (user: string, id: string) => Effect.Effect<Automation, ControlError>
  readonly create: (user: string, body: CreateAutomationBody) => Effect.Effect<Automation, ControlError>
  readonly update: (user: string, id: string, body: UpdateAutomationBody) => Effect.Effect<Automation, ControlError>
  readonly remove: (user: string, id: string) => Effect.Effect<void, ControlError>
  readonly reportToolFailures: (report: ToolFailureReport) => Effect.Effect<void, ControlError>
}

const TIMEOUT_MS = 15_000
const INVALID_ANSWER = "control plane sent an unexpected answer"

/** The control plane over HTTP(S): the scheme of the relay URL swapped, origin and base path kept, trailing slashes dropped. */
export const controlBase = (controlUrl: string): string => {
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

  // Every call is authenticated as the box, and names the user it acts for, if any, in BOX_USER_HEADER.
  const boxAuth: Record<string, string> =
    "boxSecret" in config
      ? { authorization: `Bearer ${config.boxSecret}`, [BOX_ID_HEADER]: config.boxId }
      : { authorization: `Bearer ${config.boxToken}` }
  const call = (user: string | null, method: string, path: string, body?: unknown): Effect.Effect<unknown, ControlError> =>
    Effect.gen(function* () {
      const response = yield* attempt(
        () =>
          fetch(`${base}${path}`, {
            method,
            headers: {
              ...boxAuth,
              ...(user === null ? {} : { [BOX_USER_HEADER]: user }),
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
    watchPr: (user, taskId, repo, number) => call(user, "POST", "/box/automations/pr-watch", { taskId, repo, number }).pipe(Effect.asVoid),
    unwatchPr: (user, taskId) => call(user, "DELETE", "/box/automations/pr-watch", { taskId }).pipe(Effect.asVoid),
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
    reportToolFailures: (report) => call(null, "POST", ControlPaths.boxToolFailures, report).pipe(Effect.asVoid),
  }
}

/** The control plane as this box: a managed box with its own secret, else the relayed box with the relay token. A user's own box has none. */
export const boxControl = (config: ServerConfig): ControlClient | null => {
  if (config.direct?.managed) {
    return makeControlClient({
      controlUrl: config.direct.controlUrl,
      boxId: config.direct.boxId,
      boxSecret: config.direct.boxSecret,
    })
  }
  return config.relay === null ? null : makeControlClient(config.relay)
}

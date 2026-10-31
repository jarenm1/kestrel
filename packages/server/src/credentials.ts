import { Context, Effect, Layer } from "effect"

/** One signed-in owner's connection secrets, as the control plane's box credentials answer carries them. */
export interface UserCredentials {
  readonly user: string
  readonly github?: string
  readonly anthropic?: string
  readonly openai?: string
}

/**
 * Connection secrets fetched from the control plane for each owner (`direct/auth.ts`), one slot per signed-in user,
 * replaced whenever that owner's credentials version moves on.
 * Host-side only: values here must never be passed into an agent sandbox.
 */
export interface CredentialStoreShape {
  /** Latest credentials of `user`; null before that user's first authenticated request. */
  readonly get: (user: string) => Effect.Effect<UserCredentials | null>
  readonly set: (creds: UserCredentials) => Effect.Effect<void>
}

export class CredentialStore extends Context.Tag("cloudagents/CredentialStore")<CredentialStore, CredentialStoreShape>() {}

export const CredentialStoreLive = Layer.sync(CredentialStore, () => {
  const byUser = new Map<string, UserCredentials>()
  const shape: CredentialStoreShape = {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
  return shape
})

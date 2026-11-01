import { Context, Effect, Layer } from "effect"
import type { BoxCredentials } from "@cloudagents/protocol"

/**
 * Connection secrets the control plane gave the box for each signed-in user (from `/box/self` or `/box/credentials`), one
 * slot per user, replaced whenever a fresher set is absorbed. Host-side only: values here must never be passed into an
 * agent sandbox.
 */
export interface CredentialStoreShape {
  /** Latest credentials of `user`; null before the box has fetched them for that user. */
  readonly get: (user: string) => Effect.Effect<BoxCredentials | null>
  readonly set: (creds: BoxCredentials) => Effect.Effect<void>
}

export class CredentialStore extends Context.Tag("cloudagents/CredentialStore")<CredentialStore, CredentialStoreShape>() {}

export const CredentialStoreLive = Layer.sync(CredentialStore, () => {
  const byUser = new Map<string, BoxCredentials>()
  const shape: CredentialStoreShape = {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
  return shape
})

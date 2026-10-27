import { Context, Effect, Layer } from "effect"
import type { RelayCredentials } from "@cloudagents/protocol"

/**
 * Connection secrets forwarded by the control plane (header `x-cloudagents-credentials`), one slot
 * per signed-in user, replaced on every tunnelled request that carries them.
 * Host-side only: values here must never be passed into an agent sandbox.
 */
export interface CredentialStoreShape {
  /** Latest credentials of `user`; null before that user's first relayed request. */
  readonly get: (user: string) => Effect.Effect<RelayCredentials | null>
  readonly set: (creds: RelayCredentials) => Effect.Effect<void>
}

export class CredentialStore extends Context.Tag("cloudagents/CredentialStore")<CredentialStore, CredentialStoreShape>() {}

export const CredentialStoreLive = Layer.sync(CredentialStore, () => {
  const byUser = new Map<string, RelayCredentials>()
  const shape: CredentialStoreShape = {
    get: (user) => Effect.sync(() => byUser.get(user) ?? null),
    set: (creds) => Effect.sync(() => void byUser.set(creds.user, creds)),
  }
  return shape
})

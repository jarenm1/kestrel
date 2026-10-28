import { useMemo, useSyncExternalStore } from "react"
import { Schema } from "effect"
import { AgentModel, MODEL_PROVIDERS, shownModels, type ModelInfo, type ModelProvider } from "@cloudagents/protocol"

/** Per provider: the model ids the user keeps in the chat picker. Absent until they edit the list on Connections. */
const storageKey = (provider: ModelProvider) => `kestrel.models.${provider}`

const listeners = new Set<() => void>()
let version = 0

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Another tab editing the list counts too.
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("kestrel.models.")) changed()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

function readChosen(provider: ModelProvider): readonly AgentModel[] | null {
  const raw = localStorage.getItem(storageKey(provider))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(Schema.is(AgentModel)) : null
  } catch {
    return null
  }
}

/** Saves the provider's picker list; null goes back to the catalog defaults. */
export function setShownModels(provider: ModelProvider, ids: readonly AgentModel[] | null) {
  if (ids === null) localStorage.removeItem(storageKey(provider))
  else localStorage.setItem(storageKey(provider), JSON.stringify(ids))
  changed()
}

/** The models each provider shows in the chat picker, kept current across components and tabs. */
export function useShownModels(): Record<ModelProvider, readonly ModelInfo[]> {
  // The version only says the stored lists changed; the lists themselves are re-read from storage.
  const current = useSyncExternalStore(subscribe, () => version)
  return useMemo(
    () =>
      Object.fromEntries(MODEL_PROVIDERS.map((p) => [p.id, shownModels(p.id, readChosen(p.id))])) as Record<
        ModelProvider,
        readonly ModelInfo[]
      >,
    [current],
  )
}

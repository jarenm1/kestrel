import { useMemo, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { Schema } from "effect";
import {
  AgentModel,
  MODEL_PROVIDERS,
  shownModels,
  type ModelInfo,
  type ModelProvider,
} from "@cloudagents/protocol";

/** Per provider: the model ids the user keeps in the chat picker. Absent until they edit the list on Connections. */
const storageKey = (provider: ModelProvider) => `kestrel.models.${provider}`;

const listeners = new Set<() => void>();
let version = 0;
let loaded = false;
let loading: Promise<void> | null = null;
/** The stored lists, by provider; a missing provider reads as "never edited" until secure storage answers. */
const chosen = new Map<ModelProvider, readonly AgentModel[] | null>();
/** Providers written while the first read was in flight; their in-memory list wins over the stale storage value. */
const touched = new Set<ModelProvider>();

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function parse(raw: string | null): readonly AgentModel[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Schema.is(AgentModel)) : null;
  } catch {
    return null;
  }
}

/** Reads every provider's list once; later reads only happen through `setShownModels`. */
function load() {
  if (loaded || loading !== null) return;
  loading = Promise.all(
    MODEL_PROVIDERS.map(async (provider) => {
      const raw = await SecureStore.getItemAsync(storageKey(provider.id));
      if (!touched.has(provider.id)) chosen.set(provider.id, parse(raw));
    })
  )
    .then(() => {
      loaded = true;
    })
    .catch(() => undefined)
    .finally(() => {
      loading = null;
      changed();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => {
    listeners.delete(listener);
  };
}

/** Saves the provider's picker list; null goes back to the catalog defaults. */
export function setShownModels(provider: ModelProvider, ids: readonly AgentModel[] | null): void {
  chosen.set(provider, ids);
  touched.add(provider);
  if (ids === null) void SecureStore.deleteItemAsync(storageKey(provider));
  else void SecureStore.setItemAsync(storageKey(provider), JSON.stringify(ids));
  changed();
}

/**
 * The models each provider shows in the chat picker, kept current across screens: toggling a model on Connections
 * re-renders the composer's picker without a restart.
 */
export function useShownModels(): Record<ModelProvider, readonly ModelInfo[]> {
  // The version only says the stored lists changed; the lists themselves are read from `chosen`.
  const current = useSyncExternalStore(subscribe, () => version);
  return useMemo(
    () =>
      Object.fromEntries(
        MODEL_PROVIDERS.map((provider) => [provider.id, shownModels(provider.id, chosen.get(provider.id) ?? null)])
      ) as Record<ModelProvider, readonly ModelInfo[]>,
    [current]
  );
}

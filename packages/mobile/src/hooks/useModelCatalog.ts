import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_MODELS, type Connection, type ModelCatalog } from "@cloudagents/protocol";
import { createQueries } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";

export interface ModelCatalogState {
  /** Always usable: the box's catalog, or the built-in one while loading or after a failure. */
  readonly catalog: ModelCatalog;
  /** The failed catalog read or explicit refresh, if any; per-source failures are in `catalog.sources`. */
  readonly error: unknown;
  /** An explicit refresh is in flight. */
  readonly refreshing: boolean;
  /** Re-runs discovery on the selected box, bypassing its cache. */
  readonly refresh: () => Promise<void>;
}

/** A box too old for `/api/models`, or unreachable, keeps working with the built-in catalog. */
const FALLBACK_CATALOG: ModelCatalog = { models: AGENT_MODELS, sources: [] };

/**
 * Connection metadata detects sign-in/account changes. Key replacements also invalidate the catalog explicitly;
 * secrets themselves are deliberately absent from this stamp.
 */
function credentialStamp(connections: readonly Connection[] | undefined): string | undefined {
  if (connections === undefined) return undefined;
  return connections
    .map(
      (connection) =>
        `${connection.provider}:${connection.kind}:${connection.connected ? 1 : 0}:${
          connection.available === false ? 0 : 1
        }:${connection.expired === true ? 1 : 0}:${connection.account ?? ""}`
    )
    .sort()
    .join("|");
}

/**
 * The selected box's runtime model catalog: the built-in catalog and every native model its credentials enumerate.
 * It loads on mount, polls hourly while mounted, and re-discovers after a connection changes. The returned catalog is
 * scoped by `api.boxScope`, so a box switch never shows another box's models.
 */
export function useModelCatalog(): ModelCatalogState {
  const { api } = useApiClient();
  const client = useQueryClient();
  const queries = useMemo(() => createQueries(api), [api]);
  const models = useQuery(queries.models());
  // Connection changes move this stamp; the hook then bypasses the box's discovery cache.
  const connections = useQuery(queries.connections());
  const stamp = useMemo(() => credentialStamp(connections.data), [connections.data]);
  const lastStamp = useRef({ scope: api.boxScope, stamp });
  const [refreshState, setRefreshState] = useState<{ scope: string; refreshing: boolean; error: unknown }>({
    scope: api.boxScope, refreshing: false, error: undefined,
  });

  const refresh = useCallback(async () => {
    const scope = api.boxScope;
    setRefreshState({ scope, refreshing: true, error: undefined });
    try {
      const queryKey = queries.models().queryKey;
      // A forced discovery must not join an ordinary cached read or be overwritten by a slower poll.
      await client.cancelQueries({ queryKey, exact: true });
      const catalog = await api.models(true);
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, catalog);
    } catch (error) {
      setRefreshState((current) => current.scope === scope ? { ...current, error } : current);
    } finally {
      setRefreshState((current) => current.scope === scope ? { ...current, refreshing: false } : current);
    }
  }, [api, client, queries]);

  useEffect(() => {
    // The first read is the query above; only later credential changes need an explicit refresh.
    if (lastStamp.current.scope !== api.boxScope || stamp === undefined || lastStamp.current.stamp === undefined) {
      lastStamp.current = { scope: api.boxScope, stamp };
      return;
    }
    if (stamp === lastStamp.current.stamp) return;
    lastStamp.current = { scope: api.boxScope, stamp };
    void refresh();
  }, [stamp, refresh, api.boxScope]);

  useEffect(() => {
    // A later successful poll supersedes an earlier explicit-refresh failure.
    if (models.isSuccess) setRefreshState((current) =>
      current.scope === api.boxScope ? { ...current, error: undefined } : current);
  }, [models.dataUpdatedAt, models.isSuccess, api.boxScope]);

  return {
    catalog: models.data ?? FALLBACK_CATALOG,
    error: (refreshState.scope === api.boxScope ? refreshState.error : undefined) ?? models.error,
    refreshing: models.isFetching || (refreshState.scope === api.boxScope && refreshState.refreshing),
    refresh,
  };
}

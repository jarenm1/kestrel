import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AGENT_MODELS,
  mergeModelCatalog,
  type ModelInfo,
} from "@cloudagents/protocol"
import { api } from "@/api/client"
import { ApiError } from "@/api/errors"
import { keys, modelBoxScope, queries } from "@/api/queries"

/**
 * The active box's runtime model catalog. Until a box answers (or when it cannot be reached) `models` is the curated
 * fallback catalog, so pickers keep working on an offline or older box. Refresh failures remain actionable outside
 * the model toggle menu.
 */
export interface ModelCatalogState {
  /** Curated models merged with the box's live discoveries; curated metadata wins. */
  readonly models: readonly ModelInfo[]
  /** True while the Refresh models action is in flight. */
  readonly isRefreshing: boolean
  readonly isError: boolean
  /** True when no catalog has been read from this box and the curated fallback is in use. */
  readonly isFallback: boolean
  /** The catalog read or refresh failure, if any. */
  readonly error: unknown | null
  readonly canRefresh: boolean
  /** Asks the box to bypass its discovery cache; ignored until the box list has loaded. */
  readonly refresh: () => void
}

/** The active box's model catalog, polled hourly while mounted. */
export function useModelCatalog(): ModelCatalogState {
  const client = useQueryClient()
  const boxes = useQuery(queries.boxes())
  const scope = modelBoxScope(boxes.data)
  const query = useQuery(queries.models(scope))

  // The refresh result is stored under the key it was requested for, so a box switch mid-read cannot write one box's
  // catalog into another's cache. A slower catalog read already in flight is cancelled: its result must not overwrite
  // the refreshed catalog after this mutation stores it.
  const refresh = useMutation({
    mutationFn: async (target: NonNullable<typeof scope>) => {
      const key = keys.models(target.key)
      await client.cancelQueries({ queryKey: key, exact: true })
      return { key, data: await api.models(true, target.boxId) }
    },
    onSuccess: async ({ key, data }) => {
      // A poll that started while the refresh was in flight is cancelled too, for the same reason.
      await client.cancelQueries({ queryKey: key, exact: true })
      client.setQueryData(key, data)
    },
  })
  const refreshTarget = refresh.variables
  const sameScope = scope !== undefined && refreshTarget?.key === scope.key
  // A box too old to serve `/api/models` keeps the built-in catalog quietly, as it does for capabilities. A box that
  // left the list is a real error, not an unsupported feature.
  const refreshUnsupported =
    sameScope && query.data === undefined && refresh.error instanceof ApiError &&
    refresh.error.status === 404 && refresh.error.tag !== "BoxNotFound"
  const queryUnsupported =
    query.data === undefined && query.error instanceof ApiError &&
    query.error.status === 404 && query.error.tag !== "BoxNotFound"
  // A failed manual refresh stays visible until a later catalog read succeeds; an older failure is superseded.
  const refreshError =
    sameScope && !refreshUnsupported && refresh.error !== null && refresh.submittedAt >= query.dataUpdatedAt
      ? refresh.error
      : null
  const isRefreshing = refresh.isPending && sameScope
  const queryError = queryUnsupported ? null : (query.error ?? null)
  const scopeError = scope === undefined && boxes.isError ? boxes.error : null
  const error = refreshError ?? queryError ?? scopeError
  // The server already merges the curated catalog, but re-merging keeps the built-ins even if a box answers with only
  // its discoveries, which is the same catalog every older client works from.
  const models = useMemo(
    () => (query.data === undefined ? AGENT_MODELS : mergeModelCatalog(query.data.models)),
    [query.data],
  )

  return {
    models,
    isRefreshing,
    isError: error !== null,
    isFallback: query.data === undefined,
    error,
    canRefresh: scope !== undefined && !query.isPending && !isRefreshing,
    refresh: () => {
      if (scope !== undefined) refresh.mutate(scope)
    },
  }
}

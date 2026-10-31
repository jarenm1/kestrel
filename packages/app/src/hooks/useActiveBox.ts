import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/api/client"
import { applyBoxList, queries, queryClient } from "@/api/queries"

/** The box the apps talk to: `null` for Kestrel's box, `undefined` until the box list has loaded. */
export function useActiveBoxId(): string | null | undefined {
  return useQuery(queries.boxes()).data?.activeBoxId
}

/** Makes `boxId` the active box (`null`: Kestrel's box) and drops the cached reads of the box it replaces. */
export function useSetActiveBox() {
  return useMutation({
    mutationFn: (boxId: string | null) => api.setActiveBox(boxId),
    onSuccess: (list) => applyBoxList(queryClient, list),
  })
}

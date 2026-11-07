import { useQuery } from "@tanstack/react-query"
import type { BoxCapabilities, BoxStatus as BoxStatusInfo } from "@cloudagents/protocol"
import { queries } from "@/api/queries"

/** Latest box status, or null while unknown (first poll pending or the last poll failed). */
export function useBox(): BoxStatusInfo | null {
  const box = useQuery(queries.box())
  return box.isError ? null : (box.data ?? null)
}

/** Capabilities of the active box (`BoxCapabilities`): its GPU and suspend support. Null while unknown. */
export function useBoxCapabilities(): BoxCapabilities | null {
  const capabilities = useQuery(queries.capabilities())
  return capabilities.isError ? null : (capabilities.data ?? null)
}


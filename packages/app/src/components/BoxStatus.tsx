import { useQuery } from "@tanstack/react-query"
import type { BoxCapabilities, BoxStatus as BoxStatusInfo } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { useActiveBoxId } from "@/hooks/useActiveBox"

/** Latest box status, or null while unknown (first poll pending or the last poll failed). */
export function useBox(): BoxStatusInfo | null {
  const box = useQuery(queries.box())
  return box.isError ? null : (box.data ?? null)
}

/** True only once the box is known to be offline. */
export function useBoxOffline(): boolean {
  return useBox()?.online === false
}

/** Capabilities of the active box (`BoxCapabilities`): its GPU and suspend support. Null while unknown. */
export function useBoxCapabilities(): BoxCapabilities | null {
  const capabilities = useQuery(queries.capabilities())
  return capabilities.isError ? null : (capabilities.data ?? null)
}

export function BoxOfflineBanner({ className }: { className?: string }) {
  const offline = useBoxOffline()
  const activeBoxId = useActiveBoxId()
  if (!offline) return null
  if (typeof activeBoxId === "string") {
    return (
      <Alert variant="warning" className={className}>
        Your box is offline. Check that it is running and reachable from this browser.
      </Alert>
    )
  }
  return (
    <Alert variant="warning" className={className}>
      Agent box offline. Start it with <code className="font-mono text-foreground">nix run .#box</code>
    </Alert>
  )
}

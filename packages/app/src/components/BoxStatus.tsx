import { useQuery } from "@tanstack/react-query"
import type { BoxStatus as BoxStatusInfo } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

/** Latest box status, or null while unknown (first poll pending or the last poll failed). */
export function useBox(): BoxStatusInfo | null {
  const box = useQuery(queries.box())
  return box.isError ? null : (box.data ?? null)
}

/** True only once the box is known to be offline. */
export function useBoxOffline(): boolean {
  return useBox()?.online === false
}

export function BoxPill() {
  const box = useBox()
  if (box === null) return <Badge>box …</Badge>
  return <Badge variant={box.online ? "success" : "destructive"}>box {box.online ? "online" : "offline"}</Badge>
}

export function BoxOfflineBanner() {
  const offline = useBoxOffline()
  if (!offline) return null
  return (
    <Alert variant="warning">
      Agent box offline. Start it with <code className="font-mono text-foreground">nix run .#box</code>
    </Alert>
  )
}

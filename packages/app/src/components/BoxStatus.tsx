import { useQuery } from "@tanstack/react-query"
import type { BoxHealth } from "@/api/client"
import { queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { useActiveBoxId } from "@/hooks/useActiveBox"

/** Latest box status, or null while unknown (not read yet, or the read failed). */
export function useBox(): BoxHealth | null {
  const box = useQuery(queries.box())
  return box.isError ? null : (box.data ?? null)
}

/** True only once the box is known to be offline. */
export function useBoxOffline(): boolean {
  return useBox()?.online === false
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

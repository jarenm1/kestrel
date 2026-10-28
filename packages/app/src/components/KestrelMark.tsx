import logoUrl from "@/assets/kestrel.svg"
import { cn } from "@/lib/utils"

/** The Kestrel bird. The SVG is applied as a mask over `currentColor`, so it follows the text colour. */
export function KestrelMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Kestrel"
      className={cn("inline-block aspect-[622/556] shrink-0 bg-current", className)}
      style={{ mask: `url("${logoUrl}") center / contain no-repeat` }}
    />
  )
}

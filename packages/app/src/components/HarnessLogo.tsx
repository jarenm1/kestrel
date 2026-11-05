import type { Harness } from "@/lib/harnesses"
import { cn } from "@/lib/utils"

/** The harness's logo, decorative: size it with `className`. */
export function HarnessLogo({ harness, className }: { harness: Harness; className?: string }) {
  return harness.monochrome ? (
    <span
      aria-hidden="true"
      className={cn("shrink-0 bg-current", className)}
      style={{ mask: `url("${harness.logo}") center / contain no-repeat` }}
    />
  ) : (
    <img src={harness.logo} alt="" className={cn("shrink-0 object-contain", className)} />
  )
}

import { Ban, Check, Circle, CircleAlert, LoaderCircle, X, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const ICON_BY_STATUS: Record<string, { icon: LucideIcon; color: string; glyphClassName?: string }> = {
  running: { icon: LoaderCircle, color: "text-muted-foreground", glyphClassName: "animate-spin" },
  starting: { icon: LoaderCircle, color: "text-muted-foreground", glyphClassName: "animate-spin" },
  needs_input: { icon: CircleAlert, color: "text-warning" },
  done: { icon: Check, color: "text-success" },
  succeeded: { icon: Check, color: "text-success" },
  failed: { icon: X, color: "text-destructive" },
  cancelled: { icon: Ban, color: "text-muted-foreground" },
}

const NEUTRAL = { icon: Circle, color: "text-muted-foreground", glyphClassName: "scale-50 fill-current" }

/** Icon and optional visible label share a status colour; only the glyph animates. */
export function StatusIcon({ status, label, className }: { status: string; label?: string; className?: string }) {
  const { icon: Icon, color, glyphClassName } = ICON_BY_STATUS[status] ?? NEUTRAL
  const description = label ?? status.replace("_", " ")
  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      className={cn("inline-flex shrink-0 items-center gap-1", color, className)}
    >
      <Icon aria-hidden="true" className={cn("size-4", glyphClassName)} />
      {label !== undefined && <span>{label}</span>}
    </span>
  )
}

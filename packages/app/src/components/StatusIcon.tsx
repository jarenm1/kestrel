import { Ban, Check, Circle, CircleAlert, LoaderCircle, X, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

const ICON_BY_STATUS: Record<string, { icon: LucideIcon; className: string }> = {
  running: { icon: LoaderCircle, className: "animate-spin text-muted-foreground" },
  starting: { icon: LoaderCircle, className: "animate-spin text-muted-foreground" },
  needs_input: { icon: CircleAlert, className: "text-warning" },
  done: { icon: Check, className: "text-success" },
  succeeded: { icon: Check, className: "text-success" },
  failed: { icon: X, className: "text-destructive" },
  cancelled: { icon: Ban, className: "text-muted-foreground" },
}

const NEUTRAL = { icon: Circle, className: "scale-50 fill-current text-muted-foreground" }

/** Task, run and desktop states as one small icon; the state name is its label and tooltip. */
export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const { icon: Icon, className: tone } = ICON_BY_STATUS[status] ?? NEUTRAL
  const label = status.replace("_", " ")
  return (
    <span role="img" aria-label={label} title={label} className={cn("inline-flex shrink-0", className)}>
      <Icon className={cn("size-4", tone)} />
    </span>
  )
}

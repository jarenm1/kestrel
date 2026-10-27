import type { VariantProps } from "class-variance-authority"
import { Badge, type badgeVariants } from "@/components/ui/badge"

type Variant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

const VARIANT_BY_STATUS: Record<string, Variant> = {
  running: "info",
  starting: "info",
  needs_input: "warning",
  done: "success",
  succeeded: "success",
  failed: "destructive",
  cancelled: "destructive",
}

/** Task, run and desktop states share one badge; unknown states render neutral. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT_BY_STATUS[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>
}

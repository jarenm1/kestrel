import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium lowercase",
  {
    variants: {
      variant: {
        neutral: "border-border text-muted-foreground",
        info: "border-info/60 bg-info/10 text-info",
        success: "border-success/60 bg-success/10 text-success",
        warning: "border-warning/60 bg-warning/10 text-warning",
        destructive: "border-destructive/60 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
)

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }

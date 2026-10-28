import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium lowercase",
  {
    variants: {
      variant: {
        neutral: "bg-white/[0.06] text-muted-foreground",
        info: "bg-info/12 text-info before:size-1.5 before:rounded-full before:bg-current before:content-['']",
        success: "bg-success/12 text-success before:size-1.5 before:rounded-full before:bg-current before:content-['']",
        warning: "bg-warning/12 text-warning before:size-1.5 before:rounded-full before:bg-current before:content-['']",
        destructive:
          "bg-destructive/12 text-destructive before:size-1.5 before:rounded-full before:bg-current before:content-['']",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
)

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }

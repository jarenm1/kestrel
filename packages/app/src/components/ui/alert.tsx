import type { ComponentProps } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva("w-full whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm", {
  variants: {
    variant: {
      destructive: "bg-destructive/10 text-destructive",
      warning: "bg-warning/10 text-warning",
    },
  },
  defaultVariants: { variant: "destructive" },
})

function Alert({ className, variant, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
}

export { Alert }

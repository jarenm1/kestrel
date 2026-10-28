import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-16 w-full rounded-xl bg-input px-3.5 py-2.5 text-sm shadow-well transition-[background-color,box-shadow] duration-200 ease-out outline-none placeholder:text-muted-foreground/70 focus-visible:bg-white/[0.07] focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }

import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md bg-input px-3.5 text-sm shadow-well transition-[background-color,box-shadow] duration-200 ease-out outline-none placeholder:text-muted-foreground/70 focus-visible:bg-white/[0.07] focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { Input }

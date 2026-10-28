import type { ComponentProps } from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 shadow-well transition-colors duration-200 outline-none focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-foreground shadow-soft transition-transform duration-200 data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary-foreground"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }

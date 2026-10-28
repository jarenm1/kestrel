import type { ComponentProps } from "react"
import { Check } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-[4px] bg-input shadow-well outline-none transition-colors duration-200 focus-visible:shadow-glow disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-content-center">
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }

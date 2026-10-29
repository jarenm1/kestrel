import type { ContextUsage } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** Hairline gauge of how full the thread's agent session is, for the top edge of the composer. */
export function ContextBar({ context }: { context: ContextUsage }) {
  const percent = Math.min(100, (context.usedTokens / context.windowTokens) * 100)
  const label = `${Math.round(percent)}%`
  const detail = `Context ${label}: ${tokens.format(context.usedTokens)} of ${tokens.format(context.windowTokens)} tokens${
    context.model === null ? "" : ` (${context.model})`
  }`
  return (
    <div className="flex items-center gap-2 px-2.5 pt-0.5" title={detail}>
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={detail}
        className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-white/35",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-[10px] leading-none text-muted-foreground tabular-nums">{label}</span>
    </div>
  )
}

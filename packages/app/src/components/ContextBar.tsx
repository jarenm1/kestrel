import type { ContextUsage } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/**
 * How full the thread's agent session is, drawn on the composer's top edge: a straight hairline between where the
 * rounded corners begin, filled up to the used share, with the percentage above the head and the window size above
 * the far end. Takes no layout space; the parent must be `relative` and `rounded-2xl`, whose radius is the inset.
 */
export function ContextBar({ context }: { context: ContextUsage }) {
  const percent = Math.min(100, (context.usedTokens / context.windowTokens) * 100)
  const percentLabel = `${Math.round(percent)}%`
  const detail = `Context ${percentLabel} used: ${tokens.format(context.usedTokens)} of ${tokens.format(
    context.windowTokens,
  )} tokens${context.model === null ? "" : ` (${context.model})`}`
  const label =
    "absolute bottom-full mb-1 -translate-x-1/2 text-[10px] leading-none whitespace-nowrap text-muted-foreground tabular-nums"
  return (
    <div
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={detail}
      className="pointer-events-none absolute inset-x-(--radius-2xl) top-0 h-px bg-white/10"
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-[width] duration-500",
          percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-white/60",
        )}
        style={{ width: `${percent}%` }}
      />
      <span
        className={cn(label, "transition-[left] duration-500")}
        // Stops short of the window size above the far end so the two never overlap.
        style={{ left: `min(${percent}%, calc(100% - 2rem))` }}
      >
        {percentLabel}
      </span>
      <span className={cn(label, "left-full")}>{tokens.format(context.windowTokens)}</span>
    </div>
  )
}

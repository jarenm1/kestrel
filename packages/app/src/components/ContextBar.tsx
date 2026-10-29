import type { ContextUsage } from "@cloudagents/protocol"
import { cn } from "@/lib/utils"

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/**
 * How full the thread's agent session is, drawn as the composer's top edge: a dim track along the rounded top
 * border, a filled stretch up to the used share, the percentage riding above the head and the window size above
 * the far end. Takes no layout space; the parent must be `relative` and `rounded-2xl`.
 */
export function ContextBar({ context }: { context: ContextUsage }) {
  const percent = Math.min(100, (context.usedTokens / context.windowTokens) * 100)
  const percentLabel = `${Math.round(percent)}%`
  const detail = `Context ${percentLabel} used: ${tokens.format(context.usedTokens)} of ${tokens.format(
    context.windowTokens,
  )} tokens${context.model === null ? "" : ` (${context.model})`}`
  const edge = "absolute inset-0 rounded-[inherit] border-t"
  const label = "absolute bottom-full mb-1 text-[10px] leading-none whitespace-nowrap text-muted-foreground tabular-nums"
  return (
    <div
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={detail}
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
    >
      <div className={cn(edge, "border-white/10")} />
      <div
        className={cn(
          edge,
          "transition-[clip-path] duration-500",
          percent >= 90 ? "border-destructive" : percent >= 75 ? "border-warning" : "border-white/60",
        )}
        style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
      />
      <span
        className={cn(label, "-translate-x-1/2 transition-[left] duration-500")}
        // Kept clear of the box's left end and of the window size on the right.
        style={{ left: `clamp(1.25rem, ${percent}%, calc(100% - 4.5rem))` }}
      >
        {percentLabel}
      </span>
      <span className={cn(label, "right-3")}>{tokens.format(context.windowTokens)}</span>
    </div>
  )
}

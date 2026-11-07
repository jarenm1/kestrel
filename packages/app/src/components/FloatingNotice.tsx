import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"

/**
 * A workspace-wide warning that floats over the page on frosted glass instead of pushing the layout down. Render it
 * inside `FloatingNotices`.
 */
export function FloatingNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="pointer-events-auto flex max-w-xl animate-in items-start gap-2.5 rounded-2xl bg-popover/60 px-4 py-2.5 text-sm text-foreground/90 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.85),inset_0_1px_0_0_rgb(255_255_255/0.06),0_0_0_1px_rgb(255_255_255/0.06)] backdrop-blur-xl backdrop-saturate-150 duration-300 fade-in slide-in-from-top-2"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Stacks floating notices at the top centre of the nearest positioned ancestor; clicks pass through the gaps. */
export function FloatingNotices({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex flex-col items-center gap-2 px-4">
      {children}
    </div>
  )
}

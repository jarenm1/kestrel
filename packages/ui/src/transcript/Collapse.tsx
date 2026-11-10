import { useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react"
import { cn } from "../cn"

/**
 * Slides its content open and shut by easing its height, so what sits below moves with it instead of jumping. The
 * content mounts on open and unmounts once it has slid shut; it is clipped only while moving, and its height is
 * `auto` the rest of the time, so content that grows while open (a running subagent) still pushes the page down.
 */
export function Collapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const shownRef = useRef(open)
  const [mounted, setMounted] = useState(open)
  const [moving, setMoving] = useState(false)
  if (open && !mounted) setMounted(true)

  useLayoutEffect(() => {
    const el = ref.current
    const content = contentRef.current
    if (shownRef.current === open || el === null || content === null) return
    shownRef.current = open
    // From where it is: nothing when it just mounted, else its current (possibly mid-slide) height.
    const from = open && el.style.height === "" ? 0 : el.getBoundingClientRect().height
    const to = open ? content.offsetHeight : 0
    const style = getComputedStyle(el)
    // No transition runs (reduced motion, nothing to move), so no transitionend will finish the change.
    if (from === to || style.transitionProperty === "none" || parseFloat(style.transitionDuration) === 0) {
      el.style.height = ""
      setMoving(false)
      if (!open) setMounted(false)
      return
    }
    el.style.height = `${from}px`
    // Reading layout commits the start height, so the change below transitions from it.
    el.getBoundingClientRect()
    el.style.height = `${to}px`
    setMoving(true)
  }, [open])

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "height") return
    setMoving(false)
    if (open) event.currentTarget.style.height = ""
    else setMounted(false)
  }

  if (!mounted) return null
  return (
    <div
      ref={ref}
      onTransitionEnd={onTransitionEnd}
      className={cn("min-w-0 transition-[height] duration-200 ease-out motion-reduce:transition-none", moving && "overflow-hidden")}
    >
      {/* flow-root keeps the content's margins inside the measured height. */}
      <div ref={contentRef} className="flow-root min-w-0">
        <div className={className}>{children}</div>
      </div>
    </div>
  )
}

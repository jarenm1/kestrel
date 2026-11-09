import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react"
import ChevronDown from "lucide-react/icons/chevron-down"
import ChevronUp from "lucide-react/icons/chevron-up"
import { Button } from "../button"
import { cn } from "../cn"
import {
  MINIMAP_MIN_ITEMS,
  resolveMinimapCurrentIndex,
  resolveMinimapHasPersistentGutter,
  resolveMinimapHeightStyle,
  resolveMinimapHitStripWidth,
  resolveMinimapIndexFromPointer,
  resolveMinimapInteractiveWidth,
  resolveMinimapNavigationInteractive,
  resolveMinimapPreview,
  resolveMinimapTopPercent,
  type MinimapItem,
} from "./minimap"

/** Room left above a message the minimap jumps to. */
const JUMP_OFFSET_PX = 24

function eventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null
}

// A release outside the window can skip `mouseup`, so the next button-free `mousemove` also counts.
function onMouseButtonsReleased(onRelease: () => void): () => void {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) return
    stop()
    onRelease()
  }
  const stop = () => {
    window.removeEventListener("mouseup", check)
    window.removeEventListener("mousemove", check)
  }
  window.addEventListener("mouseup", check)
  window.addEventListener("mousemove", check)
  return stop
}

function messageElement(content: HTMLElement, id: string): HTMLElement | null {
  return content.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * A rail of one strip per user message in the transcript's left gutter (ported from t3code): hovering shows the turn's
 * message and the reply it got, clicking jumps there, and the strips of messages in view light up. With a wide gutter
 * it stays visible; otherwise it shows on hover, for fine pointers only.
 */
export function TranscriptMinimap({
  items,
  scrollRef,
  contentRef,
}: {
  items: readonly MinimapItem[]
  /** The transcript's scrolling element. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** The centered content column, whose user messages carry `data-message-id`. */
  contentRef: RefObject<HTMLDivElement | null>
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [currentIndex, setCurrentIndex] = useState<number | null>(null)
  const [hasPersistentGutter, setHasPersistentGutter] = useState(false)
  const [hitStripWidth, setHitStripWidth] = useState(0)
  const [passThrough, setPassThrough] = useState(false)
  const pressedOnStripRef = useRef(false)
  const stripsRef = useRef(new Map<string, HTMLSpanElement>())
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return

    const refresh = () => {
      const view = scroll.getBoundingClientRect()
      const visible: boolean[] = []
      const above: boolean[] = []
      for (const item of itemsRef.current) {
        const rect = messageElement(content, item.id)?.getBoundingClientRect()
        const inView = rect !== undefined && rect.top < view.bottom && rect.bottom > view.top
        visible.push(inView)
        above.push(rect !== undefined && rect.bottom <= view.top)
        const strip = stripsRef.current.get(item.id)
        const next = inView ? "true" : "false"
        // Avoid dirtying style state on every scroll tick for unchanged strips.
        if (strip && strip.dataset.inView !== next) strip.dataset.inView = next
      }
      const nextCurrent = resolveMinimapCurrentIndex(visible, above)
      setCurrentIndex((current) => (current === nextCurrent ? current : nextCurrent))

      const viewportWidth = scroll.clientWidth
      const contentWidth = content.getBoundingClientRect().width
      const nextPersistent = resolveMinimapHasPersistentGutter(viewportWidth, contentWidth)
      setHasPersistentGutter((current) => (current === nextPersistent ? current : nextPersistent))
      setHitStripWidth(resolveMinimapHitStripWidth(viewportWidth, contentWidth))
    }

    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        refresh()
      })
    }
    schedule()
    scroll.addEventListener("scroll", schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(scroll)
    observer.observe(content)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      scroll.removeEventListener("scroll", schedule)
      observer.disconnect()
    }
    // Text streaming into a turn resizes the content, which the observer already covers.
  }, [scrollRef, contentRef, items.length])

  // The rail sits over the gutter, outside the scrolling element, so it hands the wheel on.
  const wheelTargetRef = (node: HTMLDivElement | null) => {
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      const scroll = scrollRef.current
      if (!scroll || event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return
      event.preventDefault()
      const pixelsPerUnit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroll.clientHeight : 1
      scroll.scrollBy({ top: event.deltaY * pixelsPerUnit })
    }
    node.addEventListener("wheel", onWheel, { passive: false })
    return () => node.removeEventListener("wheel", onWheel)
  }

  const select = (item: MinimapItem) => {
    const scroll = scrollRef.current
    const target = contentRef.current && messageElement(contentRef.current, item.id)
    if (!scroll || !target) return
    const top = scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - JUMP_OFFSET_PX
    scroll.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" })
  }

  const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null)
  const activePreview = resolveMinimapPreview(activeItem)
  const navigationInteractive = resolveMinimapNavigationInteractive(hitStripWidth) && !passThrough
  const activeTopPercent = resolvedActiveIndex === null ? 0 : resolveMinimapTopPercent(resolvedActiveIndex, items.length)
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%"
  const resolvedCurrentIndex = currentIndex !== null && currentIndex < items.length ? currentIndex : null
  const previousItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex - 1] ?? null)
  const nextItem = resolvedCurrentIndex === null ? null : (items[resolvedCurrentIndex + 1] ?? null)

  const resolveActiveIndexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return resolveMinimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    })
  }

  const moveActiveIndex = (delta: number) => {
    setActiveIndex((current) => Math.max(0, Math.min(items.length - 1, (current ?? 0) + delta)))
  }

  if (items.length < MINIMAP_MIN_ITEMS) return null

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-20 w-18",
        hasPersistentGutter
          ? "opacity-100"
          : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      ref={wheelTargetRef}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none",
          )}
          onMouseDown={() => {
            if (pressedOnStripRef.current) return
            pressedOnStripRef.current = true
            onMouseButtonsReleased(() => {
              pressedOnStripRef.current = false
            })
          }}
          onMouseMove={(event) => {
            // A drag that started elsewhere (a text selection) passes over the rail.
            if (event.buttons === 0 || pressedOnStripRef.current || passThrough) return
            setPassThrough(true)
            onMouseButtonsReleased(() => setPassThrough(false))
          }}
          style={{
            height: resolveMinimapHeightStyle(items.length),
            width: resolveMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
        >
          <MinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) select(previousItem)
            }}
          />
          <button
            aria-label={`Jump to message: ${activePreview?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (eventTargetsPreview(event.target)) return
              const nextIndex = resolveActiveIndexFromPointer(event)
              const selected = nextIndex === null ? null : (items[nextIndex] ?? null)
              if (selected) select(selected)
              event.currentTarget.blur()
            }}
            onFocus={() => setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActiveIndex(1)
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActiveIndex(-1)
              } else if (event.key === "Home") {
                event.preventDefault()
                setActiveIndex(0)
              } else if (event.key === "End") {
                event.preventDefault()
                setActiveIndex(items.length - 1)
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (activeItem) select(activeItem)
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons !== 0 && !pressedOnStripRef.current) return
              setActiveIndex(resolveActiveIndexFromPointer(event))
            }}
            onMouseDown={(event) => {
              if (eventTargetsPreview(event.target)) return
              event.preventDefault()
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const activeDistance = resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex)
              return (
                // Compositor-friendly on purpose: in-view state and the hover fisheye change on every scroll tick, so
                // the strip animates only transform and opacity.
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:bg-foreground/55 after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100",
                    activeDistance === 0 ? "bg-muted-foreground/60" : "bg-muted-foreground/25",
                    activeDistance === 0
                      ? "scale-x-100"
                      : activeDistance === 1
                        ? "scale-x-[0.667]"
                        : activeDistance === 2
                          ? "scale-x-[0.417]"
                          : "scale-x-[0.333]",
                  )}
                  data-in-view="false"
                  key={item.id}
                  ref={(node) => {
                    if (node) stripsRef.current.set(item.id, node)
                    else stripsRef.current.delete(item.id)
                  }}
                  style={{ top: `${resolveMinimapTopPercent(index, items.length)}%` }}
                />
              )
            })}
            {activePreview ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{ top: `${activeTopPercent}%`, transform: `translateY(${activeTooltipTranslate})` }}
              >
                <span className="block rounded-xl bg-popover/90 p-3 text-left text-popover-foreground shadow-soft ring-1 ring-border backdrop-blur-md">
                  <span className="block max-w-full truncate text-sm leading-5 font-medium">
                    {activePreview.userText ?? "User message"}
                  </span>
                  {activePreview.assistantText ? (
                    <span className="mt-1 line-clamp-3 max-h-15 text-sm leading-5 text-muted-foreground">
                      {activePreview.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <MinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) select(nextItem)
            }}
          />
        </div>
      </div>
    </div>
  )
}

function MinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next"
  disabled: boolean
  interactive: boolean
  onClick: () => void
}) {
  const previous = direction === "previous"
  const label = previous ? "Previous turn" : "Next turn"
  const Icon = previous ? ChevronUp : ChevronDown
  return (
    <span
      className={cn(
        "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
      )}
    >
      <Button aria-label={label} title={label} disabled={disabled} onClick={onClick} size="icon" variant="ghost" className="size-6">
        <Icon className="text-foreground/90" />
      </Button>
    </span>
  )
}

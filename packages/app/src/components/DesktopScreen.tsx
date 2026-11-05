import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from "react"
import { Maximize2, Minimize2, Volume2, VolumeX } from "lucide-react"
import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import type { DesktopSource } from "@/api/events"
import { Button } from "@cloudagents/ui/button"
import {
  contentRect,
  HeldKeys,
  keyTap,
  mouseButton,
  MODIFIERS,
  type Modifier,
  NotchAccumulator,
  normalizePoint,
  PIXELS_PER_NOTCH,
  type PointerPoint,
  typedInputs,
  wheelNotches,
} from "@/desktop/input"
import { type DesktopClose, type DesktopSession, startDesktopSession } from "@/desktop/session"
import {
  FIT_VIEW,
  GestureRecognizer,
  type GestureSink,
  MIN_SCALE,
  panView,
  type Point,
  type Scheduler,
  type TouchMode,
  type View,
  zoomView,
} from "@/desktop/touch"
import type { RtcState, RtcStats } from "@/desktop/webrtc"

/** Until the first status arrives the box assumes the usual 16:9 desktop. */
const DEFAULT_ASPECT = 16 / 9

/** After a connection ends, the next attempt waits this long. The WebRTC layer applies its own backoff on top. */
const RECONNECT_MS = 2000

/** A zero-width character the hidden input always holds, so a Backspace on an empty field is still an input event. */
const SENTINEL = "\u200b"

const UNSUPPORTED_TEXT = "This desktop cannot stream to this browser"

/** A WebRTC attempt failed and another is coming. Media has no other path, so a blocked network must be told. */
const RETRYING_TEXT = "Can't reach this desktop. Retrying… Networks that block UDP need a TURN server on the box."

const MOD_LABELS: Readonly<Record<Modifier, string>> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super" }

/** DOM key names for the toolbar's arrow keys, with the glyph each button shows. */
const ARROWS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowRight: "→",
}

const schedule: Scheduler = (ms, fn) => {
  const id = window.setTimeout(fn, ms)
  return () => window.clearTimeout(id)
}

/** The desktop's pixel size, or null before the first status: nothing maps onto the frame until then. */
function desktopSize(status: DesktopStatus | null): { width: number; height: number } | null {
  return status && status.width > 0 && status.height > 0 ? { width: status.width, height: status.height } : null
}

/**
 * Keys the box needs as key events: named keys and chords. Printable characters with no chord arrive through the
 * hidden input's input event instead, so they are not doubled. Backspace always goes through the input event.
 */
function takesKey(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (e.key === "Backspace") return false
  return e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey
}

/** Tracks whether `ref`'s element is the document's fullscreen element. */
function useIsFullscreen(ref: RefObject<HTMLElement | null>): boolean {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === ref.current)
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [ref])
  return fullscreen
}

export interface DesktopScreenProps {
  /** The stream to show, or null to stay disconnected. The parent memoizes it: a new object reconnects. */
  source: DesktopSource | null
  status: DesktopStatus | null
  /** Shown while there is no stream: a state word, or null for nothing. "loading" and "starting" show the boot bar. */
  idle: string | null
  /** Shown over the stream instead of the boot bar: why the parent cannot connect right now. */
  notice?: string | null
  /** Full-bleed touch viewer for the embed, with its toolbar. Otherwise a framed panel with a fullscreen button. */
  embedded?: boolean
  /** The frame element; the parent observes it for visibility. */
  frameRef: RefObject<HTMLDivElement | null>
  onStatus: (status: DesktopStatus) => void
  onClose: (close: DesktopClose) => void
  onStats: (stats: RtcStats | null) => void
}

export function DesktopScreen({
  source,
  status,
  idle,
  notice = null,
  embedded = false,
  frameRef,
  onStatus,
  onClose,
  onStats,
}: DesktopScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<DesktopSession | null>(null)
  const statusRef = useRef(status)
  const callbacks = useRef({ onStatus, onClose, onStats })
  const modeRef = useRef<TouchMode>("touch")
  const viewRef = useRef<View>(FIT_VIEW)
  const cursor = useRef<Point>({ x: 0.5, y: 0.5 })
  const fullscreen = useIsFullscreen(frameRef)

  const [rtc, setRtc] = useState<RtcState>("idle")
  const [audio, setAudio] = useState(false)
  const [muted, setMuted] = useState(true)
  const [keyboard, setKeyboard] = useState(false)
  const [mode, setMode] = useState<TouchMode>("touch")
  const [mods, setMods] = useState<ReadonlySet<Modifier>>(() => new Set())
  const [view, setView] = useState<View>(FIT_VIEW)
  const [cursorPos, setCursorPos] = useState<Point>({ x: 0.5, y: 0.5 })
  const [generation, setGeneration] = useState(0)
  const [scroll] = useState(() => new NotchAccumulator())
  const [heldKeys] = useState(() => new HeldKeys())
  // Latest pointer move, sent at the next animation frame. Any other input flushes it first.
  const pendingMove = useRef<DesktopInput | null>(null)
  const moveFrame = useRef(0)

  const [gesture] = useState(
    () =>
      new GestureRecognizer(
        "touch",
        {
          button: (button, down, at) => {
            if (modeRef.current === "trackpad") {
              // The click lands where the cursor is. Its position goes over the ordered channel first.
              const { x, y } = cursor.current
              send({ _tag: "mouse.move", x, y })
              send({ _tag: "mouse.button", x, y, button, down })
              return
            }
            const p = locate(at)
            if (p && (p.inside || !down)) send({ _tag: "mouse.button", x: p.x, y: p.y, button, down })
          },
          moveTo: (at) => {
            const p = locate(at)
            if (p?.inside) sendMove({ _tag: "mouse.move", x: p.x, y: p.y })
          },
          moveBy: (dx, dy) => {
            const video = videoRef.current
            const size = desktopSize(statusRef.current)
            const r = video && size ? contentRect(video, size) : null
            if (!r) return
            cursor.current = {
              x: clamp01(cursor.current.x + dx / r.width),
              y: clamp01(cursor.current.y + dy / r.height),
            }
            setCursorPos(cursor.current)
            sendMove({ _tag: "mouse.move", x: cursor.current.x, y: cursor.current.y })
          },
          pan: (dx, dy) => {
            const frame = frameRef.current
            if (frame) applyView(panView(viewRef.current, dx, dy, frame.clientWidth, frame.clientHeight))
          },
          scroll: (dx, dy) => {
            const n = scroll.add(dx / PIXELS_PER_NOTCH, dy / PIXELS_PER_NOTCH)
            if (n) send({ _tag: "mouse.wheel", dx: n.dx, dy: n.dy })
          },
          zoom: (factor, center) => {
            const frame = frameRef.current
            if (!frame) return
            const r = frame.getBoundingClientRect()
            const at = { x: center.x - r.left, y: center.y - r.top }
            applyView(zoomView(viewRef.current, factor, at, frame.clientWidth, frame.clientHeight))
          },
        } satisfies GestureSink,
        schedule,
      ),
  )

  // The connection effect reads the latest callbacks and status without reconnecting when they change.
  useEffect(() => {
    callbacks.current = { onStatus, onClose, onStats }
    statusRef.current = status
  })

  // Each connection is a billed relay request, so a null source stays disconnected. A closed connection retries after
  // RECONNECT_MS, but only while the parent still wants it: setting the source to null cancels the retry.
  useEffect(() => {
    const video = videoRef.current
    if (!video || source === null) return
    let retry: number | undefined
    const session = startDesktopSession(source, video, {
      onStatus: (s) => callbacks.current.onStatus(s),
      onRtc: setRtc,
      onStats: (s) => callbacks.current.onStats(s),
      onAudio: setAudio,
      onClose: (close) => {
        callbacks.current.onStats(null)
        callbacks.current.onClose(close)
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    })
    sessionRef.current = session
    return () => {
      window.clearTimeout(retry)
      session.close()
      sessionRef.current = null
      setRtc("idle")
      setAudio(false)
    }
  }, [source, generation])

  // Keeps the trackpad cursor dot on the desktop's content rect, which letterboxing and zoom both move.
  useEffect(() => {
    const dot = cursorRef.current
    const video = videoRef.current
    const frame = frameRef.current
    const size = desktopSize(statusRef.current)
    const r = dot && video && frame && size ? contentRect(video, size) : null
    if (!dot || !frame || !r) return
    const f = frame.getBoundingClientRect()
    dot.style.left = `${r.left - f.left + cursorPos.x * r.width}px`
    dot.style.top = `${r.top - f.top + cursorPos.y * r.height}px`
  }, [view, cursorPos, mode, rtc, status])

  // Leaving the page may not blur the input (a backgrounded WebView), and its keyups then go nowhere.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") releaseKeys()
    }
    window.addEventListener("blur", releaseKeys)
    document.addEventListener("visibilitychange", onHidden)
    return () => {
      window.removeEventListener("blur", releaseKeys)
      document.removeEventListener("visibilitychange", onHidden)
    }
  }, [])

  function releaseKeys() {
    for (const message of heldKeys.releaseAll()) send(message)
  }

  function flushMove() {
    if (moveFrame.current) cancelAnimationFrame(moveFrame.current)
    moveFrame.current = 0
    const move = pendingMove.current
    pendingMove.current = null
    if (move) sessionRef.current?.sendInput(move, true)
  }

  function send(message: DesktopInput, pointer = false) {
    flushMove()
    sessionRef.current?.sendInput(message, pointer)
  }

  /** Pointer moves coalesce to one per animation frame; the latest position wins. */
  function sendMove(message: DesktopInput) {
    pendingMove.current = message
    if (!moveFrame.current) moveFrame.current = requestAnimationFrame(flushMove)
  }

  function locate(at: Point): PointerPoint | null {
    const video = videoRef.current
    const size = desktopSize(statusRef.current)
    return video && size ? normalizePoint(video, at.x, at.y, size) : null
  }

  function applyView(next: View) {
    viewRef.current = next
    setView(next)
  }

  function toggleMode() {
    const next: TouchMode = modeRef.current === "touch" ? "trackpad" : "touch"
    modeRef.current = next
    gesture.setMode(next)
    setMode(next)
  }

  function toggleMod(m: Modifier) {
    setMods((prev) => {
      const next = new Set(prev)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  function clearMods() {
    if (mods.size > 0) setMods(new Set())
  }

  /** A named key pressed and released, with the latched modifiers held across it. */
  function tapKey(name: string) {
    for (const message of keyTap(name, [...mods])) send(message)
    clearMods()
  }

  function toggleKeyboard() {
    const input = inputRef.current
    if (!input) return
    if (document.activeElement === input) input.blur()
    else input.focus({ preventScroll: true })
  }

  function toggleAudio() {
    const video = videoRef.current
    if (!video) return
    if (!video.muted) {
      video.muted = true
      setMuted(true)
      return
    }
    video.muted = false
    setMuted(false)
    // Browsers refuse unmuted playback without a gesture; this click is one, but the attempt can still fail.
    video.play().catch(() => {
      video.muted = true
      setMuted(true)
    })
  }

  function toggleFullscreen() {
    if (fullscreen) void document.exitFullscreen()
    else void frameRef.current?.requestFullscreen()
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    // No default action: the browser's mousedown would move focus off the keyboard input this press focuses below
    // (and a touch tap must not drop the soft keyboard the user opened).
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.pointerType === "touch") {
      gesture.down(e.pointerId, { x: e.clientX, y: e.clientY }, e.timeStamp)
      return
    }
    const button = mouseButton(e.button)
    const p = locate({ x: e.clientX, y: e.clientY })
    if (!button || !p?.inside) return
    inputRef.current?.focus({ preventScroll: true })
    send({ _tag: "mouse.button", x: p.x, y: p.y, button, down: true })
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") {
      gesture.move(e.pointerId, { x: e.clientX, y: e.clientY })
      return
    }
    const p = locate({ x: e.clientX, y: e.clientY })
    if (p?.inside) sendMove({ _tag: "mouse.move", x: p.x, y: p.y })
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") {
      gesture.up(e.pointerId, e.timeStamp)
      return
    }
    const button = mouseButton(e.button)
    const p = locate({ x: e.clientX, y: e.clientY })
    // Releases are always delivered, clamped, so a button can't get stuck down on the server.
    if (button && p) send({ _tag: "mouse.button", x: p.x, y: p.y, button, down: false })
  }

  function onPointerCancel(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") gesture.cancel(e.pointerId)
  }

  function onWheel(e: WheelEvent<HTMLDivElement>) {
    const w = wheelNotches(e.nativeEvent)
    const n = scroll.add(w.dx, w.dy)
    if (n) send({ _tag: "mouse.wheel", dx: n.dx, dy: n.dy })
  }

  function onType(e: FormEvent<HTMLInputElement>) {
    const el = e.currentTarget
    const typed = el.value.split(SENTINEL).join("")
    el.value = SENTINEL
    if (typed === "") {
      tapKey("Backspace")
      return
    }
    for (const input of typedInputs(typed, [...mods])) send(input)
    clearMods()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!takesKey(e)) return
    e.preventDefault()
    send(heldKeys.press(e.nativeEvent))
  }

  function onKeyUp(e: KeyboardEvent<HTMLInputElement>) {
    const release = heldKeys.release(e.nativeEvent)
    if (release) send(release)
  }

  const size = desktopSize(status)
  const aspect = size ? size.width / size.height : DEFAULT_ASPECT
  // Booting until the peer is up. Without a source, the parent's state word says what is happening instead.
  const booting =
    source === null ? idle === "loading" || idle === "starting" : notice === null && (rtc === "idle" || rtc === "connecting")
  const text = booting
    ? null
    : source === null
      ? idle
      : (notice ?? (rtc === "unsupported" ? UNSUPPORTED_TEXT : rtc === "retrying" ? RETRYING_TEXT : null))
  const live = source !== null && rtc === "live"

  return (
    <>
      <div
        ref={frameRef}
        className={
          embedded
            ? "relative min-h-0 flex-1 overflow-hidden bg-black"
            : "relative mx-auto shrink-0 overflow-hidden rounded-xl bg-black shadow-well [&:fullscreen]:rounded-none"
        }
        style={embedded ? undefined : { aspectRatio: aspect, width: `min(100cqw, 100cqh * ${aspect})` }}
      >
        <div
          className="absolute inset-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          <video
            ref={videoRef}
            muted
            autoPlay
            playsInline
            disablePictureInPicture
            className="pointer-events-none absolute inset-0 size-full object-contain"
          />
        </div>
        {/* The touch layer: receives every pointer, so the video underneath never does. */}
        <div
          className="absolute inset-0 touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div
          ref={cursorRef}
          hidden={!live || mode !== "trackpad"}
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-white/30"
          style={{ left: "50%", top: "50%" }}
        />
        {/* Text input for the soft keyboard and hardware keys. 16px so iOS doesn't zoom on focus. */}
        <input
          ref={inputRef}
          defaultValue={SENTINEL}
          aria-label="Desktop keyboard input"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onInput={onType}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onFocus={() => setKeyboard(true)}
          onBlur={() => {
            setKeyboard(false)
            releaseKeys()
          }}
          className="absolute top-0 left-0 size-px text-base opacity-0"
        />
        {(booting || text) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-muted-foreground">
            {booting ? (
              <div role="progressbar" aria-label="Starting desktop" className="h-1 w-40 overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-1/3 animate-desktop-boot rounded-full bg-white/70 motion-reduce:animate-pulse" />
              </div>
            ) : (
              text
            )}
          </div>
        )}
        {audio && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 left-2 bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
            aria-label={muted ? "Unmute desktop audio" : "Mute desktop audio"}
            title={muted ? "Unmute desktop audio" : "Mute desktop audio"}
            onClick={toggleAudio}
          >
            {muted ? <VolumeX /> : <Volume2 />}
          </Button>
        )}
        {!embedded && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 bottom-2 bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
        )}
      </div>
      {embedded && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 bg-black/80 p-2 text-white">
          <Button size="sm" variant={keyboard ? "soft" : "ghost"} aria-pressed={keyboard} onClick={toggleKeyboard}>
            Keyboard
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleMode}>
            {mode === "touch" ? "Touch" : "Trackpad"}
          </Button>
          {MODIFIERS.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mods.has(m) ? "soft" : "ghost"}
              aria-pressed={mods.has(m)}
              onClick={() => toggleMod(m)}
            >
              {MOD_LABELS[m]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => tapKey("Escape")}>
            Esc
          </Button>
          <Button size="sm" variant="ghost" onClick={() => tapKey("Tab")}>
            Tab
          </Button>
          {Object.entries(ARROWS).map(([name, glyph]) => (
            <Button key={name} size="sm" variant="ghost" aria-label={name} onClick={() => tapKey(name)}>
              {glyph}
            </Button>
          ))}
          {view.scale > MIN_SCALE && (
            <Button size="sm" variant="ghost" onClick={() => applyView(FIT_VIEW)}>
              Fit
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

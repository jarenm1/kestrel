import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject, type WheelEvent } from "react"
import { Schema } from "effect"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react"
import {
  DEFAULT_DESKTOP_QUALITY,
  DESKTOP_QUALITIES,
  DesktopQuality,
  type DesktopInput,
  type DesktopStatus,
} from "@cloudagents/protocol"
import { api } from "@/api/client"
import { openDesktopStream, type DesktopConnection } from "@/api/events"
import { keys, queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { keyInput, mouseButton, normalizePoint } from "@/desktop/input"
import { VideoRenderer, type RenderStats } from "@/desktop/videoRenderer"
import { errorText } from "@/util"
import { StatusIcon } from "./StatusIcon"
import { MachineGraphs } from "./MachineGraphs"

const RECONNECT_MS = 2000

/** A viewer nobody can see keeps its stream this long, so switching away and back costs nothing. */
const UNSEEN_GRACE_MS = 5000

/** Until the first status arrives the box assumes the usual 16:9 desktop. */
const DEFAULT_ASPECT = 16 / 9

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

/** The desktop's stream quality; shared by every viewer, so a pick here changes it for all of them. */
function QualityPicker({
  value,
  disabled,
  onChange,
}: {
  value: DesktopQuality
  disabled: boolean
  onChange: (quality: DesktopQuality) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} className="data-[state=open]:bg-white/[0.06]">
          {DESKTOP_QUALITIES[value].label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Stream quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            if (Schema.is(DesktopQuality)(v)) onChange(v)
          }}
        >
          {DesktopQuality.literals.map((q) => (
            <DropdownMenuRadioItem key={q} value={q}>
              {DESKTOP_QUALITIES[q].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Whether anyone can see the desktop: the tab is visible and the canvas is on screen. The stream is wanted while
 * the viewer is seen, and for UNSEEN_GRACE_MS after it stops being seen. Becoming seen again is immediate.
 */
function useStreamWanted(canvasRef: RefObject<HTMLCanvasElement | null>): boolean {
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === "visible")
  const [onScreen, setOnScreen] = useState(true)
  // Starts expired when mounted in a hidden tab, so a background tab never connects.
  const [expired, setExpired] = useState(() => document.visibilityState !== "visible")
  const seen = docVisible && onScreen

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvasRef])

  useEffect(() => {
    if (seen) {
      setExpired(false)
      return
    }
    const timer = window.setTimeout(() => setExpired(true), UNSEEN_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [seen])

  return seen || !expired
}

export function DesktopViewer({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const connRef = useRef<DesktopConnection | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const fullscreen = useIsFullscreen(frameRef)
  const desktop = useQuery(queries.desktop(taskId))
  const status = desktop.data ?? null
  const [streamError, setStreamError] = useState<string | null>(null)
  const [stats, setStats] = useState<RenderStats | null>(null)
  const [generation, setGeneration] = useState(0)
  const wanted = useStreamWanted(canvasRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!wanted) {
      // Nobody can see the stream: disconnect. The server stops encoding shortly after the last viewer leaves.
      setStreamError(null)
      setStats(null)
      return
    }
    let renderer: VideoRenderer | null = null
    let mime: string | null = null
    let retry: number | undefined

    const conn = openDesktopStream(taskId, {
      onStatus: (s) => {
        queryClient.setQueryData(keys.desktop(taskId), s)
        if (s.state === "running") {
          mime = s.mime
          setStreamError(null)
          return
        }
        // Stream is not live: drop the decoder so the next start re-initializes from its init segment.
        renderer?.close()
        renderer = null
        setStats(null)
      },
      onMedia: (bytes) => {
        // The init segment is the first binary frame of a connection and follows each encoder start.
        if (!renderer) {
          if (!mime) {
            setStreamError("Stream started without a MIME type")
            return
          }
          try {
            renderer = new VideoRenderer(canvas, mime, setStats, setStreamError)
          } catch (e) {
            setStreamError(`This browser cannot decode the desktop stream: ${errorText(e)}`)
            return
          }
        }
        renderer.push(bytes)
      },
      onClose: () => {
        renderer?.close()
        renderer = null
        setStats(null)
        setStreamError("Desktop connection lost; reconnecting…")
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    })
    connRef.current = conn

    return () => {
      window.clearTimeout(retry)
      conn.close()
      renderer?.close()
      connRef.current = null
    }
  }, [taskId, generation, queryClient, wanted])

  const running = status?.state === "running"
  const active = status?.state === "running" || status?.state === "starting"
  // Over the canvas whenever no live frames can be shown: the stream is not running, or it is paused.
  const overlay = running ? (wanted ? null : "paused") : (status?.state ?? "loading")

  const toggle = useMutation({
    mutationFn: async (): Promise<DesktopStatus> => {
      if (!active) return api.startDesktop(taskId)
      await api.stopDesktop(taskId)
      return api.getDesktop(taskId)
    },
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  })
  const setQuality = useMutation({
    mutationFn: (quality: DesktopQuality) => api.setDesktopQuality(taskId, { quality }),
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  })

  function toggleFullscreen() {
    if (fullscreen) {
      void document.exitFullscreen()
      return
    }
    // The whole frame goes fullscreen so the button stays on it; the canvas keeps focus for keyboard input.
    frameRef.current?.requestFullscreen().then(
      () => canvasRef.current?.focus(),
      (e: unknown) => setStreamError(`Fullscreen refused: ${errorText(e)}`),
    )
  }

  function send(input: DesktopInput) {
    connRef.current?.send(input)
  }

  function pointer(e: MouseEvent<HTMLCanvasElement>) {
    return status ? normalizePoint(e.currentTarget, e.clientX, e.clientY, status) : null
  }

  function onMouseMove(e: MouseEvent<HTMLCanvasElement>) {
    if (!running) return
    const p = pointer(e)
    if (p?.inside) send({ _tag: "mouse.move", x: p.x, y: p.y })
  }

  function onMouseButton(e: MouseEvent<HTMLCanvasElement>, down: boolean) {
    if (!running) return
    const button = mouseButton(e.button)
    const p = pointer(e)
    if (!button || !p) return
    // Releases are always delivered (clamped) so a button can't get stuck down on the server.
    if (down && !p.inside) return
    send({ _tag: "mouse.button", x: p.x, y: p.y, button, down })
  }

  function onWheel(e: WheelEvent<HTMLCanvasElement>) {
    if (!running) return
    const dx = Math.sign(e.deltaX)
    const dy = Math.sign(e.deltaY)
    if (dx === 0 && dy === 0) return
    send({ _tag: "mouse.wheel", dx, dy })
  }

  function onKey(e: KeyboardEvent<HTMLCanvasElement>, down: boolean) {
    if (!running) return
    e.preventDefault()
    send(keyInput(e.nativeEvent, down))
  }

  const actionError = toggle.error ?? setQuality.error ?? desktop.error
  const error = actionError ? errorText(actionError) : (status?.error ?? streamError)
  // The box takes the desktop's own aspect ratio, and the largest size that fits the panel.
  const aspect = status && status.height > 0 ? status.width / status.height : DEFAULT_ASPECT

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        <Button
          variant={active ? "soft" : "default"}
          size="sm"
          onClick={() => toggle.mutate()}
          disabled={toggle.isPending || !status}
        >
          {active ? "Stop" : "Start"}
        </Button>
        {status && <StatusIcon status={status.state} />}
        <QualityPicker
          value={status?.quality ?? DEFAULT_DESKTOP_QUALITY}
          disabled={!active || setQuality.isPending}
          onChange={(quality) => setQuality.mutate(quality)}
        />
        {status && status.state === "running" && wanted && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {stats?.fps ?? 0} fps · {(stats?.decodeMs ?? 0).toFixed(1)} ms decode · {status.display}
          </span>
        )}
      </div>
      {error && <Alert className="mx-3 mb-2 w-auto">{error}</Alert>}
      {/* The stream keeps the largest size that fits the panel; the graphs go under it and scroll when they don't fit.
          The gutter is always reserved, so a scrollbar appearing never shrinks the stream and loops. */}
      <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto [container-type:size] [scrollbar-gutter:stable_both-edges]">
        <div
          ref={frameRef}
          className="relative mx-auto shrink-0 overflow-hidden rounded-xl bg-black shadow-well [&:fullscreen]:rounded-none"
          style={{ aspectRatio: aspect, width: `min(100cqw, 100cqh * ${aspect})` }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 size-full cursor-default object-contain outline-none focus:shadow-[inset_0_0_0_1px_var(--ring)]"
            tabIndex={0}
            onMouseMove={onMouseMove}
            onMouseDown={(e) => onMouseButton(e, true)}
            onMouseUp={(e) => onMouseButton(e, false)}
            onWheel={onWheel}
            onKeyDown={(e) => onKey(e, true)}
            onKeyUp={(e) => onKey(e, false)}
            onContextMenu={(e) => e.preventDefault()}
          />
          {overlay && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
              {overlay}
            </div>
          )}
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
        </div>
        <MachineGraphs />
      </div>
    </div>
  )
}

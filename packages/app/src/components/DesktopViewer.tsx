import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { openDesktopStream, type DesktopConnection } from "@/api/events"
import { keys, queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { keyInput, mouseButton, normalizePoint } from "@/desktop/input"
import { MseSink } from "@/desktop/mseSink"
import { errorText } from "@/util"
import { StatusBadge } from "./StatusBadge"

const RECONNECT_MS = 2000

export function DesktopViewer({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DesktopConnection | null>(null)
  const desktop = useQuery(queries.desktop(taskId))
  const status = desktop.data ?? null
  const [streamError, setStreamError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let sink: MseSink | null = null
    let mime: string | null = null
    let initialized = false
    let retry: number | undefined

    const conn = openDesktopStream(taskId, {
      onStatus: (s) => {
        queryClient.setQueryData(keys.desktop(taskId), s)
        if (s.state === "running") {
          mime = s.mime
          setStreamError(null)
          return
        }
        // Stream is not live: drop the current init segment so the next start re-initializes.
        sink?.close()
        sink = null
        initialized = false
      },
      onMedia: (bytes) => {
        if (!initialized) {
          // The first binary frame of each connection (or each start) is the init segment.
          initialized = true
          if (!mime) {
            setStreamError("Stream started without a MIME type")
            return
          }
          if (!MediaSource.isTypeSupported(mime)) {
            setStreamError(`This browser cannot play ${mime}`)
            return
          }
          sink = new MseSink(video, mime, setStreamError)
        }
        sink?.push(bytes)
      },
      onClose: () => {
        sink?.close()
        sink = null
        initialized = false
        setStreamError("Desktop connection lost; reconnecting…")
        retry = window.setTimeout(() => setGeneration((g) => g + 1), RECONNECT_MS)
      },
    })
    connRef.current = conn

    return () => {
      window.clearTimeout(retry)
      conn.close()
      sink?.close()
      connRef.current = null
    }
  }, [taskId, generation, queryClient])

  const running = status?.state === "running"
  const active = status?.state === "running" || status?.state === "starting"

  const toggle = useMutation({
    mutationFn: async (): Promise<DesktopStatus> => {
      if (!active) return api.startDesktop(taskId)
      await api.stopDesktop(taskId)
      return api.getDesktop(taskId)
    },
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  })

  function send(input: DesktopInput) {
    connRef.current?.send(input)
  }

  function pointer(e: MouseEvent<HTMLVideoElement>) {
    return status ? normalizePoint(e.currentTarget, e.clientX, e.clientY, status) : null
  }

  function onMouseMove(e: MouseEvent<HTMLVideoElement>) {
    if (!running) return
    const p = pointer(e)
    if (p?.inside) send({ _tag: "mouse.move", x: p.x, y: p.y })
  }

  function onMouseButton(e: MouseEvent<HTMLVideoElement>, down: boolean) {
    if (!running) return
    const button = mouseButton(e.button)
    const p = pointer(e)
    if (!button || !p) return
    // Releases are always delivered (clamped) so a button can't get stuck down on the server.
    if (down && !p.inside) return
    send({ _tag: "mouse.button", x: p.x, y: p.y, button, down })
  }

  function onWheel(e: WheelEvent<HTMLVideoElement>) {
    if (!running) return
    const dx = Math.sign(e.deltaX)
    const dy = Math.sign(e.deltaY)
    if (dx === 0 && dy === 0) return
    send({ _tag: "mouse.wheel", dx, dy })
  }

  function onKey(e: KeyboardEvent<HTMLVideoElement>, down: boolean) {
    if (!running) return
    e.preventDefault()
    send(keyInput(e.nativeEvent, down))
  }

  const actionError = toggle.error ?? desktop.error
  const error = actionError ? errorText(actionError) : (status?.error ?? streamError)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button
          variant={active ? "outline" : "default"}
          size="sm"
          onClick={() => toggle.mutate()}
          disabled={toggle.isPending || !status}
        >
          {active ? "Stop" : "Start"}
        </Button>
        {status && <StatusBadge status={status.state} />}
        {status && status.state === "running" && (
          <span className="font-mono text-xs text-muted-foreground">
            {status.width}×{status.height} · {status.fps} fps · {status.display}
          </span>
        )}
      </div>
      {error && <Alert className="m-2 w-auto">{error}</Alert>}
      <div className="relative min-h-0 flex-1 bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 size-full cursor-default object-contain outline-none focus:shadow-[inset_0_0_0_1px_var(--ring)]"
          muted
          autoPlay
          playsInline
          tabIndex={0}
          onMouseMove={onMouseMove}
          onMouseDown={(e) => onMouseButton(e, true)}
          onMouseUp={(e) => onMouseButton(e, false)}
          onWheel={onWheel}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!running && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            {status?.state ?? "loading"}
          </div>
        )}
      </div>
    </div>
  )
}

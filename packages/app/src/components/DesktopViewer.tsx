import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react"
import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import { api } from "../api/client"
import { openDesktopStream, type DesktopConnection } from "../api/events"
import { MseSink } from "../desktop/mseSink"
import { keyInput, mouseButton, normalizePoint } from "../desktop/input"
import { errorText } from "../util"
import { StatusBadge } from "./StatusBadge"

const RECONNECT_MS = 2000

export function DesktopViewer({ taskId }: { taskId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const connRef = useRef<DesktopConnection | null>(null)
  const [status, setStatus] = useState<DesktopStatus | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let active = true
    api.getDesktop(taskId).then(
      (s) => {
        if (active) setStatus(s)
      },
      (e: unknown) => {
        if (active) setActionError(errorText(e))
      },
    )
    return () => {
      active = false
    }
  }, [taskId])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let sink: MseSink | null = null
    let mime: string | null = null
    let initialized = false
    let retry: number | undefined

    const conn = openDesktopStream(taskId, {
      onStatus: (s) => {
        setStatus(s)
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
  }, [taskId, generation])

  const running = status?.state === "running"

  async function toggle() {
    if (!status) return
    setBusy(true)
    setActionError(null)
    try {
      if (status.state === "running" || status.state === "starting") {
        await api.stopDesktop(taskId)
        setStatus(await api.getDesktop(taskId))
      } else {
        setStatus(await api.startDesktop(taskId))
      }
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

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

  const error = actionError ?? status?.error ?? streamError

  return (
    <div className="desktop">
      <div className="desktop-toolbar">
        <button onClick={() => void toggle()} disabled={busy || !status}>
          {status?.state === "running" || status?.state === "starting" ? "Stop" : "Start"}
        </button>
        {status && <StatusBadge status={status.state} />}
        {status && status.state === "running" && (
          <span className="muted mono">
            {status.width}×{status.height} · {status.fps} fps · {status.display}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="desktop-stage">
        <video
          ref={videoRef}
          className="desktop-video"
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
        {!running && <div className="desktop-overlay">{status?.state ?? "loading"}</div>}
      </div>
    </div>
  )
}

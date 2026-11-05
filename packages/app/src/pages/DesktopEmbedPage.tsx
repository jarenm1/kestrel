import { useEffect, useMemo, useRef, useState } from "react"
import type { DesktopStatus } from "@cloudagents/protocol"
import type { DesktopSource } from "@/api/events"
import { DesktopScreen } from "@/components/DesktopScreen"
import { type EmbedContext, fragmentWs, HOST_TYPE, hostWs, isAuthClose, isUnreachable, mayConnect } from "@/desktop/embed"

declare global {
  interface Window {
    /** Injected by a React Native WebView host. */
    ReactNativeWebView?: { postMessage: (message: string) => void }
  }
}

const UNREACHABLE_TEXT = "Can't reach the desktop stream. Retrying…"

/** Where this page is running. Reading another site's frame throws, which is how a cross-origin parent shows. */
function embedContext(): EmbedContext {
  let framed: EmbedContext["framed"] = "no"
  if (window.parent !== window) {
    try {
      framed = window.parent.location.origin === window.location.origin ? "same-origin" : "cross-origin"
    } catch {
      framed = "cross-origin"
    }
  }
  return { origin: window.location.origin, bridged: window.ReactNativeWebView !== undefined, framed }
}

/** Posts to the host: the React Native WebView bridge when present, else the parent frame, which is this origin's. */
function postToHost(event: Record<string, string>): void {
  const message = { type: HOST_TYPE, ...event }
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message))
  else window.parent.postMessage(message, window.location.origin)
}

/**
 * Desktop viewer for a host app's WebView or iframe (`/embed/desktop`, outside sign-in). The fragment carries
 * `ws=<encoded desktop WebSocket URL>` and `task=<id>`; the host can replace the URL later by posting
 * `{"type":"kestrel-desktop","ws":"<url>"}` (an object or its JSON string). See `mayConnect` for which URLs it takes.
 */
export function DesktopEmbedPage() {
  const frameRef = useRef<HTMLDivElement>(null)
  const [ws, setWs] = useState<string | null>(() => fragmentWs(window.location.hash))
  const [authExpired, setAuthExpired] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const [status, setStatus] = useState<DesktopStatus | null>(null)

  // Only the host can replace the stream: its messages come from the parent frame, or from the WebView bridge (no
  // source window).
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== null && e.source !== window.parent) return
      const next = hostWs(e.data)
      if (next === null) return
      setAuthExpired(false)
      setWs(next)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const state = status?.state
  useEffect(() => {
    if (state !== undefined) postToHost({ event: "status", state })
  }, [state])

  const allowed = ws !== null && mayConnect(ws, embedContext())

  // Changing the source reconnects; null leaves the viewer disconnected until the host sends a new URL.
  const source = useMemo<DesktopSource | null>(
    () => (ws !== null && allowed && !authExpired ? { url: ws } : null),
    [ws, allowed, authExpired],
  )

  const idle = authExpired ? "signed out" : !allowed ? "no desktop" : (state ?? "loading")

  return (
    <div className="flex h-dvh flex-col bg-black">
      <DesktopScreen
        source={source}
        status={status}
        idle={idle}
        notice={unreachable ? UNREACHABLE_TEXT : null}
        embedded
        frameRef={frameRef}
        onStatus={(next) => {
          setUnreachable(false)
          setStatus(next)
        }}
        onClose={(close) => {
          if (isAuthClose(close)) {
            setAuthExpired(true)
            postToHost({ event: "auth-expired" })
          } else if (isUnreachable(close)) {
            setUnreachable(true)
            postToHost({ event: "unreachable" })
          }
        }}
        onStats={() => {}}
      />
    </div>
  )
}

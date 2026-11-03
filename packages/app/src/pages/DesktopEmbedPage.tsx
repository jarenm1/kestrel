import { useEffect, useMemo, useRef, useState } from "react"
import type { DesktopStatus } from "@cloudagents/protocol"
import type { DesktopSource } from "@/api/events"
import { DesktopScreen } from "@/components/DesktopScreen"
import { fragmentWs, HOST_TYPE, hostWs, isAuthClose } from "@/desktop/embed"

declare global {
  interface Window {
    /** Injected by a React Native WebView host. */
    ReactNativeWebView?: { postMessage: (message: string) => void }
  }
}

/** Posts to the host: the React Native WebView bridge when present, else the parent frame. */
function postToHost(event: Record<string, string>): void {
  const message = { type: HOST_TYPE, ...event }
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message))
  else window.parent.postMessage(message, "*")
}

/**
 * Desktop viewer for a host app's WebView or iframe (`/embed/desktop`, outside sign-in). The fragment carries
 * `ws=<encoded desktop WebSocket URL>` and `task=<id>`; the host can replace the URL later by posting
 * `{"type":"kestrel-desktop","ws":"<url>"}` (an object or its JSON string).
 */
export function DesktopEmbedPage() {
  const frameRef = useRef<HTMLDivElement>(null)
  const [ws, setWs] = useState<string | null>(() => fragmentWs(window.location.hash))
  const [authExpired, setAuthExpired] = useState(false)
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

  // Changing the source reconnects; null leaves the viewer disconnected until the host sends a new URL.
  const source = useMemo<DesktopSource | null>(() => (ws !== null && !authExpired ? { url: ws } : null), [ws, authExpired])

  const idle = authExpired ? "signed out" : ws === null ? "no desktop" : (state ?? "loading")

  return (
    <div className="flex h-dvh flex-col bg-black">
      <DesktopScreen
        source={source}
        status={status}
        idle={idle}
        embedded
        frameRef={frameRef}
        onStatus={setStatus}
        onClose={(close) => {
          if (!isAuthClose(close)) return
          setAuthExpired(true)
          postToHost({ event: "auth-expired" })
        }}
        onStats={() => {}}
      />
    </div>
  )
}

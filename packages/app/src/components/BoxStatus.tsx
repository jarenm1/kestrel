import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { BoxStatus as BoxStatusInfo } from "@cloudagents/protocol"
import { api } from "../api/client"

const BOX_POLL_MS = 10_000

const BoxContext = createContext<BoxStatusInfo | null>(null)

/** Polls `/api/box` and shares the result with the top bar and pages that need the agent box. */
export function BoxProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BoxStatusInfo | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () => {
      api.box().then(
        (box) => {
          if (active) setStatus(box)
        },
        () => {
          // Unreachable box status is shown as "unknown" (null); auth failures are handled app-wide.
          if (active) setStatus(null)
        },
      )
    }
    refresh()
    const timer = window.setInterval(refresh, BOX_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  return <BoxContext.Provider value={status}>{children}</BoxContext.Provider>
}

/** Latest box status, or null before the first successful poll. */
export function useBox(): BoxStatusInfo | null {
  return useContext(BoxContext)
}

/** True only once the box is known to be offline. */
export function useBoxOffline(): boolean {
  return useBox()?.online === false
}

export function BoxPill() {
  const box = useBox()
  if (box === null) return <span className="pill">box …</span>
  return <span className={box.online ? "pill pill-online" : "pill pill-offline"}>box {box.online ? "online" : "offline"}</span>
}

export function BoxOfflineBanner() {
  const offline = useBoxOffline()
  if (!offline) return null
  return (
    <div className="banner">
      Agent box offline — start it with <code className="mono">nix run .#box</code>
    </div>
  )
}

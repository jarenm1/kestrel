import { useEffect, useRef, useState } from "react"
import { Info, X } from "lucide-react"
import { Button } from "@cloudagents/ui/button"
import { diagnosticSummary, serializeDiagnostics, type RtcDiagnostics } from "@/desktop/diagnostics"

/** Shared by the desktop viewer and the phone embed; remains usable when WebRTC never connects. */
export function DesktopConnectionDetails({ diagnostics: d, embedded }: { diagnostics: RtcDiagnostics; embedded: boolean }) {
  const [open, setOpen] = useState(false)
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
  // The trigger and the close button replace each other, so focus follows the panel rather than dropping to <body>.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current === open) return
    wasOpen.current = open
    if (open) closeRef.current?.focus()
    else triggerRef.current?.focus()
  }, [open])
  const pair = d.selectedPair
  const rows = [
    ["Attempt / settings", `${d.attempt} / ${d.config}`],
    ["Authenticated TURN entries", String(d.turnServers)],
    ["Box TURN", d.box ? `${d.box.turnSource} / ${d.box.turnStatus}` : "Not reported by box"],
    ["TURN issue", d.box?.turnIssue ?? "None reported"],
    ["Relay candidates", `Viewer ${d.viewerRelayCandidates} / box ${d.box?.relayCandidates ?? "unknown"}`],
    ["Gathering", `Viewer ${d.viewerGathering} / box ${d.box?.gathering ?? "unknown"}`],
    ["Connection", `Viewer ${d.connection} / box ${d.box?.connection ?? "unknown"}`],
    ["Selected candidates", pair ? `${pair.local} ↔ ${pair.remote}` : "No selected pair reported"],
    ["Selected transport", pair ? `${pair.protocol} / relay ${pair.relayProtocol}` : "Unknown"],
    ["Video received", `${d.videoBytes?.toLocaleString() ?? "unknown"} bytes / ${d.videoPackets?.toLocaleString() ?? "unknown"} packets`],
    ["Frames decoded", d.framesDecoded?.toLocaleString() ?? "Unknown"],
    ["Attempt failure", d.lastFailure ?? "None recorded"],
    ["Box failure", d.box?.failure ?? "None reported"],
    ["ICE error codes", d.iceErrors.length ? d.iceErrors.map((error) => `${error.transport}: ${error.code}`).join(", ") : "None recorded"],
  ]

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(serializeDiagnostics(d))
      setCopy("copied")
    } catch {
      setCopy("failed")
    }
  }

  return (
    <div
      className={`pointer-events-none absolute inset-y-2 left-2 z-10 flex flex-col items-start justify-end gap-2 ${embedded ? "max-w-[calc(100%_-_1rem)]" : "max-w-[calc(100%_-_4rem)]"}`}
    >
      {open ? (
        <section
          aria-label="Connection details"
          className="pointer-events-auto relative flex max-h-full w-96 max-w-full flex-col rounded-lg bg-black/90 text-xs text-white/90 shadow-lg"
        >
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            className="absolute top-1 right-1 z-10 rounded-full bg-black/50 text-white/60 hover:bg-black/70 hover:text-white"
            aria-label="Close connection details"
            title="Close connection details"
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
          <div className="min-h-0 flex-1 overflow-auto p-3 pr-9">
            <p className="leading-relaxed" role="status">{diagnosticSummary(d)}</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-white/60">{label}</dt>
                  <dd className="min-w-0 text-right break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="text-white hover:bg-white/10 hover:text-white"
                title="States and counts only. No credentials, addresses, URLs or SDP."
                onClick={() => void copyReport()}
              >
                Copy redacted report
              </Button>
              {copy === "copied" && <span role="status">Copied</span>}
            </div>
            {copy === "failed" && (
              <div className="mt-2">
                <p role="status">Clipboard unavailable. Select and copy the report below.</p>
                <textarea
                  aria-label="Redacted connection report"
                  readOnly
                  value={serializeDiagnostics(d)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="mt-2 h-32 w-full resize-y rounded bg-white/10 p-2 font-mono text-[11px] text-white"
                />
              </div>
            )}
          </div>
        </section>
      ) : (
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon"
          className="pointer-events-auto bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
          aria-label="Connection details"
          title="Connection details"
          onClick={() => setOpen(true)}
        >
          <Info />
        </Button>
      )}
    </div>
  )
}

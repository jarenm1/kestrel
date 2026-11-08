import { useState } from "react"
import { Button } from "@cloudagents/ui/button"
import { diagnosticSummary, serializeDiagnostics, type RtcDiagnostics } from "@/desktop/diagnostics"

/** Shared by the desktop viewer and the phone embed; remains usable when WebRTC never connects. */
export function DesktopConnectionDetails({ diagnostics: d, embedded }: { diagnostics: RtcDiagnostics; embedded: boolean }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle")
  const pair = d.selectedPair
  const rows = [
    ["Attempt / settings", `${d.attempt} / ${d.config}`],
    ["Authenticated TURN entries", String(d.turnServers)],
    ["Box TURN", d.box ? `${d.box.turnSource} / ${d.box.turnStatus}` : "Not reported by box"],
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
    <details className={`absolute bottom-2 left-2 z-10 max-h-[calc(100%_-_1rem)] w-fit overflow-auto rounded-lg border border-white/15 bg-black/90 p-3 text-xs text-white/90 shadow-lg open:w-96 ${embedded ? "max-w-[calc(100%_-_1rem)]" : "max-w-[calc(100%_-_4rem)]"}`}>
      <summary className="cursor-pointer select-none font-medium">Connection details</summary>
      <p className="mt-3 leading-relaxed" role="status">{diagnosticSummary(d)}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-white/60">{label}</dt>
            <dd className="min-w-0 text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void copyReport()}>
          Copy redacted report
        </Button>
        {copy === "copied" && <span role="status">Copied</span>}
      </div>
      <p className="mt-2 text-white/60">States and counts only. No credentials, addresses, URLs or SDP.</p>
      {copy === "failed" && (
        <div className="mt-2">
          <p role="status">Clipboard unavailable. Select and copy the report below.</p>
          <textarea
            aria-label="Redacted connection report"
            readOnly
            value={serializeDiagnostics(d)}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-2 h-32 w-full resize-y rounded border border-white/20 bg-black p-2 font-mono text-[11px] text-white"
          />
        </div>
      )}
    </details>
  )
}

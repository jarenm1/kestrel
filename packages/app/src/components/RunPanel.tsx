import { useEffect, useRef, useState } from "react"
import type { Run } from "@cloudagents/protocol"
import { api } from "../api/client"
import { errorText, formatTime } from "../util"
import { StatusBadge } from "./StatusBadge"

interface Props {
  /** Runs sorted oldest -> newest. */
  runs: readonly Run[]
  output: Record<string, string[]>
  onRun: (run: Run) => void
}

export function RunPanel({ runs, output, onRun }: Props) {
  const current = runs.at(-1) ?? null
  const lines = current ? (output[current.id] ?? []) : []
  const logRef = useRef<HTMLPreElement>(null)
  const [cancelError, setCancelError] = useState<string | null>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  async function cancel(run: Run) {
    setCancelError(null)
    try {
      onRun(await api.cancelRun(run.id))
    } catch (e) {
      setCancelError(errorText(e))
    }
  }

  if (runs.length === 0) return null

  return (
    <div className="runs">
      {current && (
        <details className="live-log" open={current.status === "running"}>
          <summary>
            Live log · <StatusBadge status={current.status} /> <span className="muted mono">{current.id}</span>
          </summary>
          <pre ref={logRef} className="log mono">
            {lines.length === 0 ? <span className="muted">No output yet.</span> : lines.join("\n")}
          </pre>
        </details>
      )}
      {cancelError && <div className="error">{cancelError}</div>}
      <ul className="run-list">
        {[...runs].reverse().map((run) => (
          <li key={run.id} className="run-row">
            <StatusBadge status={run.status} />
            <span className="run-prompt" title={run.prompt}>
              {run.prompt}
            </span>
            <span className="muted">{formatTime(run.startedAt)}</span>
            {run.exitCode !== null && <span className="muted mono">exit {run.exitCode}</span>}
            {run.status === "running" && (
              <button className="small" onClick={() => void cancel(run)}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

import { useEffect, useRef } from "react"
import type { Run } from "@cloudagents/protocol"
import { StatusIcon } from "./StatusIcon"

interface Props {
  /** Runs sorted oldest -> newest. */
  runs: readonly Run[]
  output: Record<string, string[]>
}

/** The latest run's raw harness output, open while it runs. Stopping a run lives on the composer's button. */
export function RunPanel({ runs, output }: Props) {
  const current = runs.at(-1) ?? null
  const lines = current ? (output[current.id] ?? []) : []
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  if (!current) return null
  const running = current.status === "running"

  return (
    <div className="mx-auto max-h-[45%] w-full max-w-[calc(48rem+2.5rem)] overflow-auto px-5 py-2">
      <details open={running}>
        <summary className="mb-2 flex cursor-pointer list-none items-center gap-2 text-muted-foreground transition-colors duration-200 hover:text-foreground [&::-webkit-details-marker]:hidden">
          {running && <StatusIcon status="running" />}
          Live log
        </summary>
        <pre
          ref={logRef}
          className="m-0 max-h-56 overflow-auto rounded-xl bg-code px-3.5 py-3 font-mono text-xs break-all whitespace-pre-wrap shadow-well"
        >
          {lines.length === 0 ? <span className="text-muted-foreground">No output yet.</span> : lines.join("\n")}
        </pre>
      </details>
    </div>
  )
}

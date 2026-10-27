import { useEffect, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Run } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { errorText, formatTime } from "@/util"
import { StatusBadge } from "./StatusBadge"

interface Props {
  taskId: string
  /** Runs sorted oldest -> newest. */
  runs: readonly Run[]
  output: Record<string, string[]>
}

export function RunPanel({ taskId, runs, output }: Props) {
  const queryClient = useQueryClient()
  const current = runs.at(-1) ?? null
  const lines = current ? (output[current.id] ?? []) : []
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, run)),
  })

  if (runs.length === 0) return null

  return (
    <div className="max-h-[45%] overflow-auto border-t px-4 py-2">
      {current && (
        <details open={current.status === "running"}>
          <summary className="mb-1.5 flex cursor-pointer items-center gap-2 text-muted-foreground">
            Live log <StatusBadge status={current.status} />
            <span className="font-mono text-xs">{current.id}</span>
          </summary>
          <pre
            ref={logRef}
            className="m-0 max-h-56 overflow-auto rounded-md border bg-code px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap"
          >
            {lines.length === 0 ? <span className="text-muted-foreground">No output yet.</span> : lines.join("\n")}
          </pre>
        </details>
      )}
      {cancel.error && <Alert className="mt-1.5">{errorText(cancel.error)}</Alert>}
      <ul className="mt-1.5">
        {[...runs].reverse().map((run) => (
          <li key={run.id} className="flex min-w-0 items-center gap-2 py-1">
            <StatusBadge status={run.status} />
            <span className="min-w-0 flex-1 truncate" title={run.prompt}>
              {run.prompt}
            </span>
            <span className="text-muted-foreground">{formatTime(run.startedAt)}</span>
            {run.exitCode !== null && (
              <span className="font-mono text-xs text-muted-foreground">exit {run.exitCode}</span>
            )}
            {run.status === "running" && (
              <Button
                variant="outline"
                size="sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                Cancel
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

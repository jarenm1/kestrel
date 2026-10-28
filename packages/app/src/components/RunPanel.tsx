import { useEffect, useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Run } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { errorText } from "@/util"
import { StatusIcon } from "./StatusIcon"

interface Props {
  taskId: string
  /** Runs sorted oldest -> newest. */
  runs: readonly Run[]
  output: Record<string, string[]>
}

/** The latest run's raw harness output, collapsed unless it is running, with Cancel while it runs. */
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

  if (!current) return null
  const running = current.status === "running"

  return (
    <div className="mx-auto max-h-[45%] w-full max-w-[calc(48rem+2.5rem)] overflow-auto px-5 py-2">
      <details open={running}>
        <summary className="mb-2 flex cursor-pointer list-none items-center gap-2 text-muted-foreground transition-colors duration-200 hover:text-foreground [&::-webkit-details-marker]:hidden">
          {running && <StatusIcon status="running" />}
          Live log
          {running && (
            <Button
              variant="soft"
              size="sm"
              className="ml-auto"
              disabled={cancel.isPending}
              onClick={(e) => {
                // Inside <summary>: don't also toggle the log.
                e.preventDefault()
                cancel.mutate(current.id)
              }}
            >
              Cancel
            </Button>
          )}
        </summary>
        <pre
          ref={logRef}
          className="m-0 max-h-56 overflow-auto rounded-xl bg-code px-3.5 py-3 font-mono text-xs break-all whitespace-pre-wrap shadow-well"
        >
          {lines.length === 0 ? <span className="text-muted-foreground">No output yet.</span> : lines.join("\n")}
        </pre>
      </details>
      {cancel.error && <Alert className="mt-2">{errorText(cancel.error)}</Alert>}
    </div>
  )
}

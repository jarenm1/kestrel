import type { Task, UsageLimitResume } from "@cloudagents/protocol"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@cloudagents/ui/button"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"

const resetLabel = (resetsAt: string): string => {
  const at = Date.parse(resetsAt)
  return Number.isNaN(at)
    ? "when the limit resets"
    : new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

/** The thread's armed usage-limit resume, or nothing when it has none. */
export function UsageLimitNotice({ task }: { task: Task | undefined }) {
  const arm = task?.usageLimitResume
  if (task === undefined || arm === undefined) return null
  return <ArmedUsageLimit task={task} arm={arm} />
}

/**
 * The box will send "Continue where you left off." when the provider's window resets. Cancelling keeps the notice, so
 * the user can turn it back on for this thread.
 */
function ArmedUsageLimit({ task, arm }: { task: Task; arm: UsageLimitResume }) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (autoResume: boolean) => api.setUsageLimitAutoResume(task.id, autoResume),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.task(updated.id), updated)
      queryClient.setQueryData(keys.tasks, (list: Task[] | undefined) => upsert(list, updated))
    },
  })
  const paused = !arm.autoResume
  const at = resetLabel(arm.resetsAt)
  return (
    <div
      role="status"
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-3 rounded-xl border border-warning/25 bg-warning/10 px-4 py-3 text-sm"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">Usage limit reached</div>
        <p className="text-xs text-muted-foreground">
          {paused
            ? `Auto-resume is off for this thread. The limit resets ${at}.`
            : `This thread resumes automatically ${at}, when the provider's limit resets.`}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(paused)}
      >
        {paused ? "Resume at reset" : "Cancel auto-resume"}
      </Button>
      {toggle.error && <span className="text-xs text-destructive">Could not change auto-resume.</span>}
    </div>
  )
}

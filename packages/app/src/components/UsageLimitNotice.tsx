import type { Task, UsageLimitResume } from "@cloudagents/protocol"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@cloudagents/ui/button"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"
import { errorText } from "@/util"

/** When a usage-limit arm resets, in the user's locale ("Nov 7, 3:00 PM"). */
export const resetLabel = (resetsAt: string): string => {
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
 *
 * A delegated thread's parent waits for it while it is armed: its result goes up after the resumed run. "Return to
 * parent now" ends that wait (the box drops the arm and sends the parent the failed run's result).
 */
function ArmedUsageLimit({ task, arm }: { task: Task; arm: UsageLimitResume }) {
  const queryClient = useQueryClient()
  const stored = (updated: Task) => {
    queryClient.setQueryData(keys.task(updated.id), updated)
    queryClient.setQueryData(keys.tasks, (list: Task[] | undefined) => upsert(list, updated))
  }
  const toggle = useMutation({
    mutationFn: (autoResume: boolean) => api.setUsageLimitAutoResume(task.id, autoResume),
    onSuccess: stored,
  })
  const parentTaskId = task.delegation?.cancelledAt === undefined ? task.delegation?.parentTaskId : undefined
  const returnEarly = useMutation({
    mutationFn: (parentId: string) => api.cancelDelegation(parentId, task.id),
    onSuccess: stored,
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
          {parentTaskId !== undefined &&
            (paused
              ? " Its parent gets this failed result; send a message here to keep working on it."
              : " Its parent gets the result after that.")}
        </p>
      </div>
      {parentTaskId !== undefined && !paused && (
        <Button size="sm" variant="ghost" disabled={returnEarly.isPending} onClick={() => returnEarly.mutate(parentTaskId)}>
          Return to parent now
        </Button>
      )}
      {/*
        A paused delegated child can resume for its parent only while its failed result has not reached the parent yet
        (it waits while the parent is on a usage limit too). The app cannot tell, so the box decides and says why.
      */}
      <Button
        size="sm"
        variant="ghost"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(paused)}
      >
        {paused ? "Resume at reset" : "Cancel auto-resume"}
      </Button>
      {toggle.error && <span className="text-xs text-destructive">{errorText(toggle.error)}</span>}
      {returnEarly.error && <span className="text-xs text-destructive">Could not return the task to its parent.</span>}
    </div>
  )
}

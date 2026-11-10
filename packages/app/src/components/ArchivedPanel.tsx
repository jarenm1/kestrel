import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Trash2 } from "lucide-react"
import type { Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { dropTask, queries, storeTask } from "@/api/queries"
import { ThreadAvatar } from "@/components/ThreadAvatar"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { threadPath } from "@/routes"
import { errorText, formatAgo, repoShortName } from "@/util"

/**
 * Runs `action` on every thread at once. Threads that succeed stay done when others fail; the error names how many
 * failed (a single thread's own error passes through).
 */
async function eachThread(taskIds: readonly string[], verb: string, action: (taskId: string) => Promise<void>) {
  const results = await Promise.allSettled(taskIds.map(action))
  const failed = results.filter((result) => result.status === "rejected")
  if (failed.length === 0) return
  if (taskIds.length === 1) throw failed[0]!.reason
  throw new Error(`Could not ${verb} ${failed.length} of ${taskIds.length} threads: ${errorText(failed[0]!.reason)}`)
}

/**
 * The user's archived threads, most recently archived first. Each opens read-only; Unarchive brings one back and
 * Delete removes it for good after a confirmation. Select picks several to unarchive or delete together.
 */
export function ArchivedPanel() {
  const queryClient = useQueryClient()
  const tasks = useQuery(queries.tasks())
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [confirming, setConfirming] = useState<readonly Task[] | null>(null)
  const archived = (tasks.data ?? [])
    .filter((task) => task.archivedAt !== undefined)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""))
  // Threads unarchived or deleted elsewhere drop out of the selection.
  const selected = archived.filter((task) => picked.has(task.id))

  function stopSelecting() {
    setSelecting(false)
    setPicked(new Set())
  }

  function toggle(taskId: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current)
      if (on) next.add(taskId)
      else next.delete(taskId)
      return next
    })
  }

  const unarchive = useMutation({
    mutationFn: (taskIds: readonly string[]) =>
      eachThread(taskIds, "unarchive", async (taskId) => storeTask(queryClient, await api.unarchiveTask(taskId))),
    onSuccess: stopSelecting,
  })
  const remove = useMutation({
    mutationFn: (taskIds: readonly string[]) =>
      eachThread(taskIds, "delete", async (taskId) => {
        await api.deleteTask(taskId)
        dropTask(queryClient, taskId)
      }),
    onSuccess: stopSelecting,
    onSettled: () => setConfirming(null),
  })
  const pending = new Set([
    ...(unarchive.isPending ? unarchive.variables : []),
    ...(remove.isPending ? remove.variables : []),
  ])

  return (
    <>
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h2 className="text-lg font-semibold tracking-tight">Archived threads</h2>
          <p className="text-muted-foreground">
            Archived threads keep their history and checkouts. Unarchive one to continue it.
          </p>
        </div>
        {archived.length > 0 && (
          <Button variant="soft" size="sm" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
            {selecting ? "Cancel" : "Select"}
          </Button>
        )}
      </div>
      {selecting && archived.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-background/60 px-4 py-2 shadow-well">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={selected.length === archived.length ? true : selected.length > 0 ? "indeterminate" : false}
              onCheckedChange={(checked) =>
                setPicked(new Set(checked === true ? archived.map((task) => task.id) : []))
              }
            />
            {selected.length > 0 ? `${selected.length} selected` : "Select all"}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="soft"
              size="sm"
              disabled={selected.length === 0 || unarchive.isPending}
              onClick={() => unarchive.mutate(selected.map((task) => task.id))}
            >
              {unarchive.isPending ? "Unarchiving…" : "Unarchive"}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={selected.length === 0 || remove.isPending}
              onClick={() => setConfirming(selected)}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      {tasks.error && <Alert>{errorText(tasks.error)}</Alert>}
      {unarchive.error && <Alert>{errorText(unarchive.error)}</Alert>}
      {remove.error && <Alert>{errorText(remove.error)}</Alert>}
      {tasks.data && archived.length === 0 && (
        <Card>
          <CardContent className="items-center py-10 text-center text-muted-foreground">
            <p className="font-medium text-foreground">No archived threads.</p>
          </CardContent>
        </Card>
      )}
      {archived.map((task) => (
        <Card key={task.id} className={cn(selecting && picked.has(task.id) && "ring-1 ring-primary/60")}>
          <CardContent className="flex items-center gap-4">
            {selecting && (
              <Checkbox
                aria-label={`Select ${task.title}`}
                checked={picked.has(task.id)}
                onCheckedChange={(checked) => toggle(task.id, checked === true)}
              />
            )}
            <ThreadAvatar task={task} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link to={threadPath(task.id)} className="truncate font-medium hover:underline">
                {task.title}
              </Link>
              <span className="truncate text-xs text-muted-foreground">
                {task.checkouts.length > 0
                  ? task.checkouts.map((checkout) => repoShortName(checkout.repo)).join(", ")
                  : "No repository"}
                {task.archivedAt && <> · archived {formatAgo(task.archivedAt, Date.now())}</>}
              </span>
            </div>
            {!selecting && (
              <>
                <Button
                  variant="soft"
                  size="sm"
                  disabled={pending.has(task.id)}
                  onClick={() => unarchive.mutate([task.id])}
                >
                  Unarchive
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${task.title}`}
                  title="Delete"
                  className="hover:bg-destructive/15 hover:text-destructive"
                  disabled={pending.has(task.id)}
                  onClick={() => setConfirming([task])}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      ))}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirming(null)
        }}
      >
        <DialogContent>
          {confirming && (
            <>
              <DialogTitle>
                {confirming.length === 1 ? "Delete thread?" : `Delete ${confirming.length} threads?`}
              </DialogTitle>
              <DialogDescription>
                {confirming.length === 1 ? (
                  <>
                    <span className="font-medium text-foreground">{confirming[0]!.title}</span> and its history,
                    checkouts and files are deleted for good.
                  </>
                ) : (
                  "These threads and their history, checkouts and files are deleted for good."
                )}{" "}
                This cannot be undone.
              </DialogDescription>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={remove.isPending} onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(confirming.map((task) => task.id))}
                >
                  {remove.isPending ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

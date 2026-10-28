import type { Task } from "@cloudagents/protocol"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { errorText } from "@/util"

/** Stands in for the composer on an archived thread: its history stays readable until it is unarchived. */
export function ArchivedNotice({ task }: { task: Task }) {
  const { unarchive } = useThreadArchive(task.repoId)
  return (
    <div className="flex w-full max-w-3xl flex-col gap-2 rounded-xl bg-background/60 p-4 shadow-well sm:flex-row sm:items-center">
      <p className="flex-1 text-sm text-muted-foreground">This thread is archived. Unarchive it to send messages again.</p>
      <Button variant="soft" size="sm" disabled={unarchive.isPending} onClick={() => unarchive.mutate(task.id)}>
        Unarchive
      </Button>
      {unarchive.error && <Alert className="w-full">{errorText(unarchive.error)}</Alert>}
    </div>
  )
}

import { Link } from "react-router-dom"
import type { Task } from "@cloudagents/protocol"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { errorText, formatAgo } from "@/util"

/** A repo's archived threads, most recently archived first. Each opens read-only; Unarchive brings one back. */
export function ArchivedPanel({ repoId, tasks }: { repoId: string; tasks: readonly Task[] | undefined }) {
  const { unarchive } = useThreadArchive(repoId)
  const archived = (tasks ?? [])
    .filter((task) => task.archivedAt !== undefined)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Archived threads</h2>
        <p className="text-sm text-muted-foreground">
          Archived threads keep their history and branch. Unarchive one to continue it.
        </p>
      </div>
      {unarchive.error && <Alert>{errorText(unarchive.error)}</Alert>}
      {tasks && archived.length === 0 && (
        <Card>
          <CardContent className="items-center py-10 text-center text-muted-foreground">
            <p className="font-medium text-foreground">No archived threads.</p>
          </CardContent>
        </Card>
      )}
      {archived.map((task) => (
        <Card key={task.id}>
          <CardContent className="flex items-center gap-4">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Link to={`/repos/${repoId}/threads/${task.id}`} className="truncate font-medium hover:underline">
                {task.title}
              </Link>
              <span className="truncate text-xs text-muted-foreground">
                {task.branch}
                {task.archivedAt && <> · archived {formatAgo(task.archivedAt, Date.now())}</>}
              </span>
            </div>
            <Button
              variant="soft"
              size="sm"
              disabled={unarchive.isPending && unarchive.variables === task.id}
              onClick={() => unarchive.mutate(task.id)}
            >
              Unarchive
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

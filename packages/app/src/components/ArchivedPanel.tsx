import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { queries } from "@/api/queries"
import { useThreadArchive } from "@/hooks/useThreadArchive"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { threadPath } from "@/routes"
import { errorText, formatAgo, repoShortName } from "@/util"

/** The user's archived threads, most recently archived first. Each opens read-only; Unarchive brings one back. */
export function ArchivedPanel() {
  const tasks = useQuery(queries.tasks())
  const { unarchive } = useThreadArchive()
  const archived = (tasks.data ?? [])
    .filter((task) => task.archivedAt !== undefined)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Archived threads</h2>
        <p className="text-sm text-muted-foreground">
          Archived threads keep their history and checkouts. Unarchive one to continue it.
        </p>
      </div>
      {tasks.error && <Alert>{errorText(tasks.error)}</Alert>}
      {unarchive.error && <Alert>{errorText(unarchive.error)}</Alert>}
      {tasks.data && archived.length === 0 && (
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

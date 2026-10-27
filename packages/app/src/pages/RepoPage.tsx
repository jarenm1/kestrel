import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useParams } from "react-router-dom"
import type { Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { StatusBadge } from "@/components/StatusBadge"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorText, formatTime } from "@/util"

export function RepoPage() {
  const { repoId = "" } = useParams()
  const queryClient = useQueryClient()
  const repo = useQuery(queries.repo(repoId))
  const tasks = useQuery(queries.repoTasks(repoId))
  const [title, setTitle] = useState("")

  const createTask = useMutation({
    mutationFn: (taskTitle: string) => api.createTask(repoId, { title: taskTitle || undefined }),
    onSuccess: (task) => {
      queryClient.setQueryData(keys.repoTasks(repoId), (list: readonly Task[] | undefined) => [
        task,
        ...(list ?? []).filter((t) => t.id !== task.id),
      ])
      setTitle("")
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    createTask.mutate(title.trim())
  }

  const error = createTask.error ?? repo.error ?? tasks.error

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 overflow-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{repo.data?.name ?? "Repository"}</h1>
        {repo.data && <div className="font-mono text-xs text-muted-foreground">{repo.data.url}</div>}
      </div>
      <BoxOfflineBanner />
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          className="max-w-md"
          placeholder="Task title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" disabled={createTask.isPending}>
          {createTask.isPending ? "Creating…" : "New task"}
        </Button>
      </form>
      {error && <Alert>{errorText(error)}</Alert>}
      {tasks.data?.length === 0 && <div className="text-muted-foreground">No tasks yet.</div>}
      {tasks.data && tasks.data.length > 0 && (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.data.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <StatusBadge status={task.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/tasks/${task.id}`} className="font-medium text-primary hover:underline">
                      {task.title}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{task.branch}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(task.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import type { Repo, Task } from "@cloudagents/protocol"
import { api } from "../api/client"
import { BoxOfflineBanner } from "../components/BoxStatus"
import { StatusBadge } from "../components/StatusBadge"
import { errorText, formatTime } from "../util"

/** Task statuses change from agent runs with no repo-level event stream, so the list is polled. */
const TASK_POLL_MS = 2000

export function RepoPage() {
  const { repoId = "" } = useParams()
  const [repo, setRepo] = useState<Repo | null>(null)
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [title, setTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.getRepo(repoId).then(
      (r) => {
        if (active) setRepo(r)
      },
      (e: unknown) => {
        if (active) setError(errorText(e))
      },
    )
    return () => {
      active = false
    }
  }, [repoId])

  useEffect(() => {
    let active = true
    const refresh = () => {
      api.listRepoTasks(repoId).then(
        (list) => {
          if (!active) return
          setTasks(list)
          setError(null)
        },
        (e: unknown) => {
          if (active) setError(errorText(e))
        },
      )
    }
    refresh()
    const timer = window.setInterval(refresh, TASK_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [repoId])

  async function createTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const task = await api.createTask(repoId, { title: title.trim() || undefined })
      setTasks((list) => [task, ...list.filter((t) => t.id !== task.id)])
      setTitle("")
    } catch (err) {
      setError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="page">
      <h1>{repo?.name ?? "Repository"}</h1>
      <BoxOfflineBanner />
      {repo && <div className="muted mono">{repo.url}</div>}
      <form className="row-form" onSubmit={(e) => void createTask(e)}>
        <input placeholder="Task title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" disabled={creating}>
          {creating ? "Creating…" : "New task"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
      {tasks.length === 0 && <div className="muted">No tasks yet.</div>}
      <table className="tasks">
        <thead>
          <tr>
            <th>Status</th>
            <th>Title</th>
            <th>Branch</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <StatusBadge status={task.status} />
              </td>
              <td>
                <Link to={`/tasks/${task.id}`}>{task.title}</Link>
              </td>
              <td className="mono muted">{task.branch}</td>
              <td className="muted">{formatTime(task.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { NavLink, useNavigate, useParams } from "react-router-dom"
import { SquarePen } from "lucide-react"
import type { SendMessageBody, Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { Composer } from "@/components/Composer"
import { StatusIcon } from "@/components/StatusIcon"
import { ThreadView } from "@/components/ThreadView"
import { Alert } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

const TITLE_MAX = 60

/** Thread states worth an icon in the tab list; finished and idle threads stay quiet. */
const LOUD_STATUS: Record<Task["status"], boolean> = {
  idle: false,
  running: true,
  needs_input: true,
  done: false,
  failed: true,
}

/**
 * A repo's workspace: threads (tasks) as vertical tabs on the page background, and the open thread in a raised
 * panel. `/repos/:repoId` is an empty chat whose first message starts a new thread.
 */
export function RepoPage() {
  const { repoId = "", taskId } = useParams()
  const repo = useQuery(queries.repo(repoId))
  const tasks = useQuery(queries.repoTasks(repoId))
  const error = repo.error ?? tasks.error

  return (
    <>
      <BoxOfflineBanner className="mx-3 mb-2 w-auto" />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Threads" className="flex w-64 shrink-0 flex-col gap-0.5 overflow-auto pb-3 pl-3">
          <div className="truncate px-2.5 pt-1 pb-3 font-medium" title={repo.data?.url}>
            {repo.data?.name ?? "Repository"}
          </div>
          <NavLink to={`/repos/${repoId}`} end className={tabClass}>
            <SquarePen className="size-4 shrink-0" />
            New thread
          </NavLink>
          {error && <Alert className="mt-2 mr-3 w-auto">{errorText(error)}</Alert>}
          {tasks.data && tasks.data.length > 0 && (
            <div className="px-2.5 pt-4 pb-1 text-xs text-muted-foreground">Threads</div>
          )}
          {/* TODO: order by the user's last message, not updatedAt (which also moves when a run finishes);
              needs a `lastMessageAt` on Task from the server. */}
          {[...(tasks.data ?? [])]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((task) => (
              <NavLink
                key={task.id}
                to={`/repos/${repoId}/threads/${task.id}`}
                className={tabClass}
                title={`${task.title}\n${task.branch}`}
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {LOUD_STATUS[task.status] && <StatusIcon status={task.status} />}
                </span>
                <span className="truncate">{task.title}</span>
              </NavLink>
            ))}
          {/* TODO: thread actions (rename, archive/delete via DELETE /api/tasks/:id) from a tab context menu. */}
        </nav>
        <div className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-soft">
          {taskId ? (
            <ThreadView key={taskId} taskId={taskId} />
          ) : (
            <NewThread repoId={repoId} repoName={repo.data?.name} />
          )}
        </div>
      </div>
    </>
  )
}

/** The active tab takes the panel's colour and loses its right corners, so it reads as part of the panel. */
function tabClass({ isActive }: { isActive: boolean }) {
  return cn(
    "flex min-w-0 items-center gap-2.5 rounded-xl py-2 pr-3 pl-2.5 text-muted-foreground transition-colors duration-200 hover:bg-white/[0.03] hover:text-foreground",
    isActive && "rounded-r-none bg-card text-foreground hover:bg-card",
  )
}

/** First line of the prompt, shortened, as the thread's title (and branch name). */
function threadTitle(text: string): string {
  const line = (text.split("\n", 1)[0] ?? "").replace(/\s+/g, " ").trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** Empty chat: the first message creates a thread (task), sends the message to it and opens it. */
function NewThread({ repoId, repoName }: { repoId: string; repoName: string | undefined }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // TODO: let the agent name the thread from the conversation instead of the first line of the prompt.
  const start = useMutation({
    mutationFn: async (body: SendMessageBody) => {
      const task = await api.createTask(repoId, { title: threadTitle(body.text) })
      // The thread exists from here on, even if the message below fails.
      void queryClient.invalidateQueries({ queryKey: keys.repoTasks(repoId) })
      return { task, sent: await api.sendMessage(task.id, body) }
    },
    onSuccess: ({ task, sent }) => {
      queryClient.setQueryData(keys.repoTasks(repoId), (list: readonly Task[] | undefined) => [
        task,
        ...(list ?? []).filter((t) => t.id !== task.id),
      ])
      queryClient.setQueryData(keys.messages(task.id), [sent.message])
      queryClient.setQueryData(keys.runs(task.id), [sent.run])
      navigate(`/repos/${repoId}/threads/${task.id}`)
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-center text-xl font-semibold tracking-tight">
        What should the agent do{repoName ? <> in {repoName}</> : null}?
      </h1>
      <Composer
        onSend={start.mutateAsync}
        pending={start.isPending}
        error={start.error}
        placeholder="Describe a task (Enter to send, Shift+Enter for newline)"
        autoFocus
      />
    </div>
  )
}

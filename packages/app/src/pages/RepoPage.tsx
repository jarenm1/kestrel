import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "react-router-dom"
import type { SendMessageBody, Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { ArchivedPanel } from "@/components/ArchivedPanel"
import { AutomationsPanel } from "@/components/AutomationsPanel"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { Composer } from "@/components/Composer"
import { ThreadSidebar } from "@/components/ThreadSidebar"
import { ThreadView } from "@/components/ThreadView"

const TITLE_MAX = 60

/**
 * A repo's workspace: threads (tasks) as vertical tabs on the page background, and the open thread in a raised
 * panel. `/repos/:repoId` is an empty chat whose first message starts a new thread. With `view="automations"` the
 * raised panel lists the repo's automations, and with `view="archived"` its archived threads, instead.
 */
export function RepoPage({ view }: { view?: "automations" | "archived" }) {
  const { repoId = "", taskId } = useParams()
  const repo = useQuery(queries.repo(repoId))
  const tasks = useQuery(queries.repoTasks(repoId))
  const error = repo.error ?? tasks.error

  return (
    <>
      <BoxOfflineBanner className="mx-3 mb-2 w-auto" />
      <div className="flex min-h-0 flex-1">
        <ThreadSidebar
          repoId={repoId}
          repoName={repo.data?.name}
          repoUrl={repo.data?.url}
          tasks={tasks.data}
          error={error}
        />
        <div className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-soft">
          {view === "automations" ? (
            <AutomationsPanel repoId={repoId} repoName={repo.data?.name} />
          ) : view === "archived" ? (
            <ArchivedPanel repoId={repoId} tasks={tasks.data} />
          ) : taskId ? (
            <ThreadView key={taskId} taskId={taskId} />
          ) : (
            <NewThread repoId={repoId} repoName={repo.data?.name} />
          )}
        </div>
      </div>
    </>
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

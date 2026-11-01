import { useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { GithubRepoSlug, type SendMessageBody, type Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, storeTask } from "@/api/queries"
import { Composer } from "@/components/Composer"
import { RepoPicker } from "@/components/RepoPicker"
import { useStoredChoice } from "@/hooks/useStoredChoice"
import { threadPath } from "@/routes"
import { repoShortName, threadTitle } from "@/util"

/**
 * Chat home: the first message creates a thread (task), sends the message to it and opens it. With a repository
 * picked in the bar under the box, the thread starts with it checked out; otherwise the agent checks out the ones it
 * needs.
 */
export function NewThreadPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [repo, setRepo] = useStoredChoice("kestrel.newThreadRepo", GithubRepoSlug)
  // The thread created by an earlier attempt, and the repository it was created with; a retry after a failed send
  // reuses it instead of creating another, unless the repository was changed since.
  const created = useRef<{ task: Task; repo: string | undefined } | null>(null)

  // TODO: let the agent name the thread from the conversation instead of the first line of the prompt.
  const start = useMutation({
    mutationFn: async ({ body, files }: { body: SendMessageBody; files: readonly File[] }) => {
      // A message of only files is titled after the first one.
      const title = threadTitle(body.text) || threadTitle(files[0]?.name ?? "")
      const previous = created.current
      const task =
        previous !== null && previous.repo === repo
          ? previous.task
          : await api.createTask({ title, ...(repo === undefined ? {} : { checkout: { repo } }) })
      created.current = { task, repo }
      // The thread exists from here on, even if the message below fails.
      storeTask(queryClient, task)
      return { task, sent: await api.sendMessage(task.id, body, files) }
    },
    onSuccess: ({ task, sent }) => {
      queryClient.setQueryData(keys.messages(task.id), [sent.message])
      queryClient.setQueryData(keys.runs(task.id), [sent.run])
      navigate(threadPath(task.id))
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-center text-xl font-semibold tracking-tight">What should we work on?</h1>
      <div className="flex w-full max-w-3xl flex-col">
        <Composer
          onSend={(body, files) => start.mutateAsync({ body, files })}
          pending={start.isPending}
          error={start.error}
          placeholder={
            repo === undefined
              ? "Ask for anything — the agent checks out the repos it needs"
              : `Ask for anything in ${repoShortName(repo)}`
          }
          autoFocus
        />
        <div className="mx-4 flex min-w-0 items-center gap-2 rounded-b-xl bg-input px-1.5 py-1 text-xs text-muted-foreground shadow-well">
          <RepoPicker value={repo} onChange={setRepo} disabled={start.isPending} />
          <span className="ml-auto truncate pr-1.5">
            {repo === undefined ? "The agent picks repositories as it goes" : "Checked out before the agent starts"}
          </span>
        </div>
      </div>
    </div>
  )
}

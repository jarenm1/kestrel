import { useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import type { SendMessageBody, Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, storeTask } from "@/api/queries"
import { Composer } from "@/components/Composer"
import { threadTitle } from "@/util"

/**
 * Chat home: the first message creates a thread (task), sends the message to it and opens it. The thread starts with
 * no repository; the agent checks out the ones it needs.
 */
export function NewThreadPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // The thread created by an earlier attempt; a retry after a failed send reuses it instead of creating another.
  const created = useRef<Task | null>(null)

  // TODO: let the agent name the thread from the conversation instead of the first line of the prompt.
  const start = useMutation({
    mutationFn: async (body: SendMessageBody) => {
      const task = created.current ?? (await api.createTask({ title: threadTitle(body.text) }))
      created.current = task
      // The thread exists from here on, even if the message below fails.
      storeTask(queryClient, task)
      return { task, sent: await api.sendMessage(task.id, body) }
    },
    onSuccess: ({ task, sent }) => {
      queryClient.setQueryData(keys.messages(task.id), [sent.message])
      queryClient.setQueryData(keys.runs(task.id), [sent.run])
      navigate(`/threads/${task.id}`)
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-center text-xl font-semibold tracking-tight">What should we work on?</h1>
      <Composer
        onSend={start.mutateAsync}
        pending={start.isPending}
        error={start.error}
        placeholder="Ask for anything — the agent checks out the repos it needs"
        autoFocus
      />
    </div>
  )
}

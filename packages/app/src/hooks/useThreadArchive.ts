import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, upsert } from "@/api/queries"

/**
 * Archive and unarchive a thread. The box returns the updated task, which replaces it in the repo's thread list and
 * in the open thread's cache, so the sidebar and the thread view agree without waiting for the next poll.
 */
export function useThreadArchive(repoId: string) {
  const queryClient = useQueryClient()
  const store = (updated: Task) => {
    queryClient.setQueryData(keys.repoTasks(repoId), (list: readonly Task[] | undefined) => upsert(list, updated))
    queryClient.setQueryData(keys.task(updated.id), updated)
  }
  const archive = useMutation({ mutationFn: (taskId: string) => api.archiveTask(taskId), onSuccess: store })
  const unarchive = useMutation({ mutationFn: (taskId: string) => api.unarchiveTask(taskId), onSuccess: store })
  return { archive, unarchive }
}

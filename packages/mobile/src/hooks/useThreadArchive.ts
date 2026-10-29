import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { storeTask } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * Archive and unarchive a thread. The box returns the updated task, which replaces it in the thread list and in the
 * thread's own cache entry, so the sidebar and the thread view agree without waiting for the next poll.
 */
export function useThreadArchive() {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (taskId: string) => api.archiveTask(taskId),
    onSuccess: (updated: Task) => storeTask(queryClient, updated),
  });
  const unarchive = useMutation({
    mutationFn: (taskId: string) => api.unarchiveTask(taskId),
    onSuccess: (updated: Task) => storeTask(queryClient, updated),
  });
  return { archive, unarchive };
}

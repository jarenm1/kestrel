import { useMutation, useQueryClient } from "@tanstack/react-query";
import { storeTaskMutation } from "@/api/queries";
import { useApiClient } from "@/hooks/useApiClient";

/**
 * Archive and unarchive a thread. The box returns the updated task, which replaces it in the thread list and in the
 * thread's own cache entry, so the sidebar and the thread view agree without waiting for the next poll.
 */
export function useThreadArchive() {
  const { api } = useApiClient();
  const queryClient = useQueryClient();
  const archive = useMutation(storeTaskMutation(queryClient, api, (taskId) => api.archiveTask(taskId)));
  const unarchive = useMutation(storeTaskMutation(queryClient, api, (taskId) => api.unarchiveTask(taskId)));
  return { archive, unarchive };
}

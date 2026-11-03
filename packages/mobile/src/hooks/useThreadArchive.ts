import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { storeTask, type ThreadCall } from "@/api/queries";

/**
 * Archive and unarchive options. The box client travels in the variables and the response is written to that box's
 * cache, so a request still pending when the active box changes cannot write into the new box.
 */
export function threadArchiveOptions(queryClient: QueryClient) {
  return {
    archive: {
      mutationFn: ({ api, taskId }: ThreadCall) => api.archiveTask(taskId),
      onSuccess: (updated: Task, { api }: ThreadCall) => storeTask(queryClient, updated, api.boxScope),
    },
    unarchive: {
      mutationFn: ({ api, taskId }: ThreadCall) => api.unarchiveTask(taskId),
      onSuccess: (updated: Task, { api }: ThreadCall) => storeTask(queryClient, updated, api.boxScope),
    },
  };
}

/**
 * Archive and unarchive a thread. The box returns the updated task, which replaces it in the thread list and in the
 * thread's own cache entry, so the sidebar and the thread view agree without waiting for the next poll.
 */
export function useThreadArchive() {
  const queryClient = useQueryClient();
  const options = threadArchiveOptions(queryClient);
  return {
    archive: useMutation(options.archive),
    unarchive: useMutation(options.unarchive),
  };
}

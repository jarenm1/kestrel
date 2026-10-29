import { useMutation } from "@tanstack/react-query"
import { api } from "@/api/client"

export function useSignOut() {
  return useMutation({
    mutationFn: api.logout,
    // Reload re-checks the session either way.
    onSettled: () => window.location.reload(),
  })
}

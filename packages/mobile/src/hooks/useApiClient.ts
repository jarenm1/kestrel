import { useMemo } from "react";
import { createApiClient, type ApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/**
 * Hook to get an API client bound to the current auth context and active box. Memoized so query functions keep stable
 * references; a new client is built when the session, the server or the active box changes.
 */
export function useApiClient(): { api: ApiClient } {
  const { serverUrl, sessionCookie, activeBox } = useAuth();

  const api = useMemo(
    () => createApiClient(serverUrl ?? "", sessionCookie, activeBox),
    [serverUrl, sessionCookie, activeBox]
  );

  return { api };
}


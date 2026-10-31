import { useMemo } from "react";
import { createApiClient, type ApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/**
 * Hook to get an API client bound to the current auth context.
 * Memoized so query functions keep stable references.
 */
export function useApiClient(): { api: ApiClient; serverUrl: string | null } {
  const { serverUrl, sessionCookie } = useAuth();

  const api = useMemo(
    () => createApiClient(serverUrl ?? "", sessionCookie),
    [serverUrl, sessionCookie]
  );

  return { api, serverUrl };
}


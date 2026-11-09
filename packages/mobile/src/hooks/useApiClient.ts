import { createContext, useContext, useMemo } from "react";
import { createApiClient, type ActiveBox, type ApiClient } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";

/** Overrides the client for a subtree: a thread opened on another box reads and writes through that box's client. */
export const BoxApiContext = createContext<ApiClient | null>(null);

/**
 * Hook to get the API client for the subtree: the box a screen above overrode with `BoxApiContext`, else the active
 * box's client. Memoized so query functions keep stable references.
 */
export function useApiClient(): { api: ApiClient } {
  const override = useContext(BoxApiContext);
  const { activeBox } = useAuth();
  const active = useBoxClient(activeBox);
  return { api: override ?? active };
}

/** The client for one box (`null` is Kestrel's relayed box). A new client is built when the session, server or box changes. */
export function useBoxClient(box: ActiveBox | null): ApiClient {
  const { serverUrl, sessionCookie, sessionEpoch } = useAuth();
  const boxId = box?.id ?? null;
  const boxUrl = box?.url ?? null;
  return useMemo(
    () =>
      createApiClient(
        serverUrl ?? "",
        sessionCookie,
        boxId === null || boxUrl === null ? null : { id: boxId, url: boxUrl },
        sessionEpoch
      ),
    [serverUrl, sessionCookie, boxId, boxUrl, sessionEpoch]
  );
}


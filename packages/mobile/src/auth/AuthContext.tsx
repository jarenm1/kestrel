import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import type { Me, UserBox } from "@cloudagents/protocol";
import { createApiClient } from "@/api/client";
import { clearBoxScopedQueries } from "@/api/queries";

const SERVER_URL_KEY = "kestrel_server_url";
const SESSION_COOKIE_KEY = "kestrel_session";

interface AuthState {
  /** Base URL of the Kestrel control plane, e.g. "https://app.kestrel-agent.com" */
  serverUrl: string | null;
  /** Session cookie value captured after OAuth */
  sessionCookie: string | null;
  /** Current signed-in user, or null if not authenticated */
  user: Me | null;
  /** The user's own boxes (bring your own box); loaded with `/api/me` */
  boxes: readonly UserBox[];
  /** The box the user's apps use; `null` is Kestrel's box */
  activeBoxId: string | null;
  /** Whether we're currently checking auth state */
  loading: boolean;
  /** Last auth error */
  error: string | null;
}

interface AuthActions {
  setServerUrl: (url: string) => Promise<void>;
  setSessionCookie: (cookie: string) => Promise<void>;
  setUser: (user: Me) => void;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  setActiveBox: (boxId: string | null) => Promise<void>;
}

/** `activeBox` is the box the app's requests go to; `null` is Kestrel's box. */
type AuthContextValue = AuthState & AuthActions & { activeBox: UserBox | null };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    serverUrl: null,
    sessionCookie: null,
    user: null,
    loading: true,
    error: null,
    boxes: [],
    activeBoxId: null,
  });
  const queryClient = useQueryClient();
  const activeBox = useMemo(
    () => state.boxes.find((box) => box.id === state.activeBoxId) ?? null,
    [state.boxes, state.activeBoxId]
  );

  // Load saved server URL and session on mount
  useEffect(() => {
    (async () => {
      try {
        const savedUrl = await SecureStore.getItemAsync(SERVER_URL_KEY);
        const savedCookie = await SecureStore.getItemAsync(SESSION_COOKIE_KEY);
        const urlToUse = savedUrl || "https://app.kestrel-agent.com";
        
        setState((s) => ({
          ...s,
          serverUrl: urlToUse,
          sessionCookie: savedCookie,
        }));

        if (savedCookie) {
          await fetchMe(urlToUse, savedCookie, setState);
        } else {
          setState((s) => ({ ...s, loading: false }));
        }
      } catch {
        setState((s) => ({ ...s, loading: false }));
      }
    })();
  }, []);

  const setServerUrl = useCallback(async (url: string) => {
    const cleaned = url.replace(/\/+$/, "");
    await SecureStore.setItemAsync(SERVER_URL_KEY, cleaned);
    setState((s) => ({ ...s, serverUrl: cleaned, error: null }));
  }, []);

  const setSessionCookie = useCallback(
    async (cookie: string) => {
      await SecureStore.setItemAsync(SESSION_COOKIE_KEY, cookie);
      setState((s) => ({ ...s, sessionCookie: cookie, loading: true, error: null }));
      if (state.serverUrl) {
        await fetchMe(state.serverUrl, cookie, setState);
      }
    },
    [state.serverUrl]
  );

  const setUser = useCallback((user: Me) => {
    setState((s) => ({ ...s, user, loading: false, error: null }));
  }, []);

  const signOut = useCallback(async () => {
    if (state.serverUrl && state.sessionCookie) {
      try {
        await fetch(`${state.serverUrl}/auth/logout`, {
          method: "POST",
          // The explicit session header is authoritative; RN otherwise merges in WebView cookies.
          credentials: "omit",
          headers: { Cookie: `session=${state.sessionCookie}` },
        });
      } catch {
        // Ignore logout errors
      }
    }
    await SecureStore.deleteItemAsync(SESSION_COOKIE_KEY);
    setState((s) => ({
      ...s,
      sessionCookie: null,
      boxes: [],
      activeBoxId: null,
      user: null,
      error: null,
    }));
  }, [state.serverUrl, state.sessionCookie]);

  const setActiveBox = useCallback(
    async (boxId: string | null) => {
      if (!state.serverUrl) throw new Error("Server URL is not set");
      const list = await createApiClient(state.serverUrl, state.sessionCookie, null).setActiveBox(boxId);
      // Box-served data describes the box that was active; drop it before the switch takes effect.
      clearBoxScopedQueries(queryClient);
      setState((s) => ({ ...s, boxes: list.boxes, activeBoxId: list.activeBoxId }));
    },
    [state.serverUrl, state.sessionCookie, queryClient]
  );

  const checkSession = useCallback(async () => {
    if (state.serverUrl && state.sessionCookie) {
      await fetchMe(state.serverUrl, state.sessionCookie, setState);
    }
  }, [state.serverUrl, state.sessionCookie]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        setServerUrl,
        setSessionCookie,
        setUser,
        signOut,
        checkSession,
        setActiveBox,
        activeBox,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

async function fetchMe(
  serverUrl: string,
  sessionCookie: string | null,
  setState: React.Dispatch<React.SetStateAction<AuthState>>
) {
  try {
    const headers: Record<string, string> = {};
    if (sessionCookie) {
      headers["Cookie"] = `session=${sessionCookie}`;
    }
    const res = await fetch(`${serverUrl}/api/me`, {
      headers,
      // Do not combine the secure-store session with the native/WebView cookie jar.
      credentials: "omit",
    });
    if (res.status === 401) {
      setState((s) => ({ ...s, user: null, loading: false, error: null }));
      return;
    }
    if (!res.ok) {
      setState((s) => ({
        ...s,
        loading: false,
        error: `Server returned ${res.status}`,
      }));
      return;
    }
    const user: Me = await res.json();
    // Signing in never depends on the box list: when it cannot be read, the app stays on Kestrel's box.
    const boxes = await createApiClient(serverUrl, sessionCookie, null)
      .boxes()
      .catch(() => ({ boxes: [], activeBoxId: null }));
    setState((s) => ({ ...s, user, boxes: boxes.boxes, activeBoxId: boxes.activeBoxId, loading: false, error: null }));
  } catch (e) {
    setState((s) => ({
      ...s,
      loading: false,
      error: `Cannot reach server: ${e instanceof Error ? e.message : String(e)}`,
    }));
  }
}

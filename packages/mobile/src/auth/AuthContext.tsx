import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import type { Me } from "@/api/types";

const SERVER_URL_KEY = "kestrel_server_url";
const SESSION_COOKIE_KEY = "kestrel_session";

interface AuthState {
  /** Base URL of the Kestrel control plane, e.g. "https://app.kestrel-agent.com" */
  serverUrl: string | null;
  /** Session cookie value captured after OAuth */
  sessionCookie: string | null;
  /** Current signed-in user, or null if not authenticated */
  user: Me | null;
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
}

type AuthContextValue = AuthState & AuthActions;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    serverUrl: null,
    sessionCookie: null,
    user: null,
    loading: true,
    error: null,
  });

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
      user: null,
      error: null,
    }));
  }, [state.serverUrl, state.sessionCookie]);

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
      credentials: "include",
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
    setState((s) => ({ ...s, user, loading: false, error: null }));
  } catch (e) {
    setState((s) => ({
      ...s,
      loading: false,
      error: `Cannot reach server: ${e instanceof Error ? e.message : String(e)}`,
    }));
  }
}

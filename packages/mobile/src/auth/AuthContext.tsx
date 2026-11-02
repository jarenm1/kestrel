import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { storage } from "@/lib/storage";
import type { BoxList, ManagedBox, Me, UserBox } from "@cloudagents/protocol";
import { createApiClient, type ActiveBox } from "@/api/client";
import { fetchCredentials, hostOrigin } from "@/auth/session";

const SERVER_URL_KEY = "kestrel_server_url";
const SESSION_COOKIE_KEY = "kestrel_session";
/** Served by the app host (web): the browser holds the session cookie, so there is always a session to check. */
const browserSession = hostOrigin !== null;

function sessionHeaders(sessionCookie: string | null): Record<string, string> {
  return sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};
}

interface AuthState {
  /** Base URL of the Kestrel control plane, e.g. "https://app.kestrel-agent.com" */
  serverUrl: string | null;
  /** Session cookie value captured after OAuth (native); always `null` on the web, where the browser keeps it */
  sessionCookie: string | null;
  /** Current signed-in user, or null if not authenticated */
  user: Me | null;
  /** The user's own boxes (bring your own box); loaded with `/api/me` */
  boxes: readonly UserBox[];
  /** The box the user's apps use; `null` is Kestrel's managed box */
  activeBoxId: string | null;
  /** Kestrel's managed box assigned to the user, reached directly; `null` when none is assigned (the relay serves Kestrel's box). */
  managedBox: ManagedBox | null;
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

/** `activeBox` is the box the app's requests go to, reached directly; `null` means Kestrel's box is relayed. */
type AuthContextValue = AuthState & AuthActions & { activeBox: ActiveBox | null };

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
    managedBox: null,
  });
  const activeBox = useMemo(
    () => resolveActiveBox(state.boxes, state.activeBoxId, state.managedBox),
    [state.boxes, state.activeBoxId, state.managedBox]
  );
  const applyBoxList = useCallback((list: BoxList) => {
    setState((s) => ({ ...s, boxes: list.boxes, activeBoxId: list.activeBoxId, managedBox: list.managedBox }));
  }, []);

  // Load saved server URL and session on mount
  useEffect(() => {
    (async () => {
      try {
        const savedUrl = hostOrigin ?? (await storage.getItem(SERVER_URL_KEY));
        const savedCookie = browserSession ? null : await storage.getItem(SESSION_COOKIE_KEY);
        const urlToUse = savedUrl || "https://app.kestrel-agent.com";

        setState((s) => ({
          ...s,
          serverUrl: urlToUse,
          sessionCookie: savedCookie,
        }));

        if (savedCookie || browserSession) {
          await fetchMe(urlToUse, savedCookie, setState, applyBoxList);
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
    await storage.setItem(SERVER_URL_KEY, cleaned);
    setState((s) => ({ ...s, serverUrl: cleaned, error: null }));
  }, []);

  const setSessionCookie = useCallback(
    async (cookie: string) => {
      await storage.setItem(SESSION_COOKIE_KEY, cookie);
      setState((s) => ({ ...s, sessionCookie: cookie, loading: true, error: null }));
      if (state.serverUrl) {
        await fetchMe(state.serverUrl, cookie, setState, applyBoxList);
      }
    },
    [state.serverUrl, applyBoxList]
  );

  const setUser = useCallback((user: Me) => {
    setState((s) => ({ ...s, user, loading: false, error: null }));
  }, []);

  const signOut = useCallback(async () => {
    if (state.serverUrl && (state.sessionCookie || browserSession)) {
      try {
        await fetch(`${state.serverUrl}/auth/logout`, {
          method: "POST",
          // Native: the explicit session header is authoritative; RN otherwise merges in WebView cookies.
          credentials: fetchCredentials,
          headers: sessionHeaders(state.sessionCookie),
        });
      } catch {
        // Ignore logout errors
      }
    }
    await storage.deleteItem(SESSION_COOKIE_KEY);
    setState((s) => ({
      ...s,
      sessionCookie: null,
      boxes: [],
      activeBoxId: null,
      managedBox: null,
      user: null,
      error: null,
    }));
  }, [state.serverUrl, state.sessionCookie]);

  const setActiveBox = useCallback(
    async (boxId: string | null) => {
      if (!state.serverUrl) throw new Error("Server URL is not set");
      const list = await createApiClient(state.serverUrl, state.sessionCookie, null).setActiveBox(boxId);
      applyBoxList(list);
    },
    [state.serverUrl, state.sessionCookie, applyBoxList]
  );

  const checkSession = useCallback(async () => {
    if (state.serverUrl && (state.sessionCookie || browserSession)) {
      await fetchMe(state.serverUrl, state.sessionCookie, setState, applyBoxList);
    }
  }, [state.serverUrl, state.sessionCookie, applyBoxList]);

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
  setState: React.Dispatch<React.SetStateAction<AuthState>>,
  applyBoxList: (list: BoxList) => void
) {
  try {
    const res = await fetch(`${serverUrl}/api/me`, {
      headers: sessionHeaders(sessionCookie),
      // Native: do not combine the secure-store session with the native/WebView cookie jar.
      credentials: fetchCredentials,
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
    // Signing in never depends on the box list: when it cannot be read, the box state already held stays.
    const boxes = await createApiClient(serverUrl, sessionCookie, null)
      .boxes()
      .catch(() => null);
    if (boxes !== null) applyBoxList(boxes);
    setState((s) => ({ ...s, user, loading: false, error: null }));
  } catch (e) {
    setState((s) => ({
      ...s,
      loading: false,
      error: `Cannot reach server: ${e instanceof Error ? e.message : String(e)}`,
    }));
  }
}

/**
 * The box the apps' requests go to: the user's chosen box, or with no choice (`activeBoxId` null) their managed box.
 * `null` means no direct box applies and Kestrel's box is relayed through the control plane.
 */
function resolveActiveBox(
  boxes: readonly UserBox[],
  activeBoxId: string | null,
  managedBox: ManagedBox | null
): ActiveBox | null {
  if (activeBoxId === null) return managedBox === null ? null : { id: managedBox.id, url: managedBox.url };
  const box = boxes.find((b) => b.id === activeBoxId);
  return box === undefined ? null : { id: box.id, url: box.url };
}

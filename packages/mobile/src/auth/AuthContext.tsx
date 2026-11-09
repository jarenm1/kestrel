import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { storage } from "@/lib/storage";
import type { BoxList, ManagedBox, Me, UserBox } from "@cloudagents/protocol";
import { createApiClient, onUnauthorized, type ActiveBox } from "@/api/client";
import { fetchCredentials, hostOrigin } from "@/auth/session";
import { initialAuthState, launched, boxesLoaded, noSession, signedIn, type AuthState } from "@/auth/sessionState";
import {
  createSessionMachine,
  type CheckOutcome,
  type CheckSessionOptions,
} from "@/auth/sessionMachine";

const SERVER_URL_KEY = "kestrel_server_url";
const SESSION_COOKIE_KEY = "kestrel_session";
const DEFAULT_SERVER_URL = "https://app.kestrel-agent.com";
/** Served by the app host (web): the browser holds the session cookie, so there is always a session to check. */
const browserSession = hostOrigin !== null;

function sessionHeaders(sessionCookie: string | null): Record<string, string> {
  return sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};
}

interface AuthActions {
  setServerUrl: (url: string) => Promise<void>;
  setSessionCookie: (cookie: string) => Promise<void>;
  setUser: (user: Me) => void;
  signOut: () => Promise<void>;
  checkSession: (options?: CheckSessionOptions) => Promise<void>;
  setActiveBox: (boxId: string | null) => Promise<void>;
}

/** `activeBox` is the box the app's requests go to, reached directly; `null` means Kestrel's box is relayed. */
type AuthContextValue = AuthState & AuthActions & { activeBox: ActiveBox | null };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(initialAuthState);
  const queryClient = useQueryClient();
  // The machine reads the latest state through this ref, so its callbacks stay stable while the state moves.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The machine owns the check attempt counter and the session generation; a check, expiry or sign-out supersedes
  // whatever was in flight, and a 401 only expires the generation that reported it.
  const session = useMemo(
    () =>
      createSessionMachine({
        state: () => stateRef.current,
        update: (change) => setState(change),
        browserSession,
        check: checkSessionWithApi,
        logout: async (serverUrl, sessionCookie) => {
          await fetch(`${serverUrl}/auth/logout`, {
            method: "POST",
            // Native: the explicit session header is authoritative; RN otherwise merges in WebView cookies.
            credentials: fetchCredentials,
            headers: sessionHeaders(sessionCookie),
          });
        },
        removeStoredSession: async () => {
          try {
            await storage.deleteItem(SESSION_COOKIE_KEY);
          } catch {
            // A failed delete must not leave the app claiming a live session; the server has already refused it.
          }
        },
        resetQueries: async () => {
          await queryClient.cancelQueries();
          queryClient.clear();
        },
      }),
    [queryClient]
  );

  const activeBox = useMemo(
    () => resolveActiveBox(state.boxes, state.activeBoxId, state.managedBox),
    [state.boxes, state.activeBoxId, state.managedBox]
  );
  const applyBoxList = useCallback((list: BoxList) => {
    setState((s) => boxesLoaded(s, list));
  }, []);

  // Load the saved server URL and session on mount, then check it: a stored session that the server has forgotten is
  // an expiry, not a signed-in app with failing requests.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const savedUrl = hostOrigin ?? (await storage.getItem(SERVER_URL_KEY));
        const savedCookie = browserSession ? null : await storage.getItem(SESSION_COOKIE_KEY);
        const urlToUse = savedUrl || DEFAULT_SERVER_URL;
        if (!active) return;
        setState((s) => launched(s, urlToUse, savedCookie));
        await session.check({ serverUrl: urlToUse, sessionCookie: savedCookie });
      } catch {
        if (active) setState(noSession);
      }
    })();
    return () => {
      active = false;
    };
  }, [session]);

  // Any control-plane call rejected with 401 means the session is expired, wherever the user is in the app.
  useEffect(() => onUnauthorized((epoch) => void session.expire(epoch)), [session]);

  // A resumed app rechecks the session: it may have expired while the app was in the background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void session.check({ quiet: true });
    });
    return () => subscription.remove();
  }, [session]);

  const setServerUrl = useCallback(async (url: string) => {
    const cleaned = url.replace(/\/+$/, "");
    await storage.setItem(SERVER_URL_KEY, cleaned);
    setState((s) => ({ ...s, serverUrl: cleaned, error: null }));
  }, []);

  const setSessionCookie = useCallback(
    async (cookie: string) => {
      await storage.setItem(SESSION_COOKIE_KEY, cookie);
      await session.startSession(stateRef.current.serverUrl, cookie);
    },
    [session]
  );

  const setUser = useCallback((user: Me) => {
    setState((s) => signedIn(s, user));
  }, []);

  const setActiveBox = useCallback(
    async (boxId: string | null) => {
      const { serverUrl, sessionCookie } = stateRef.current;
      if (serverUrl === null) throw new Error("Server URL is not set");
      const list = await createApiClient(
        serverUrl,
        sessionCookie,
        null,
        session.sessionEpoch()
      ).setActiveBox(boxId);
      applyBoxList(list);
    },
    [applyBoxList, session]
  );

  return (
    <AuthContext.Provider
      value={{
        ...state,
        setServerUrl,
        setSessionCookie,
        setUser,
        signOut: session.signOut,
        checkSession: session.check,
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

/** One `/api/me` exchange; the machine decides which generation may apply the answer. */
async function checkSessionWithApi(
  serverUrl: string,
  sessionCookie: string | null,
  sessionEpoch: number
): Promise<CheckOutcome> {
  try {
    const res = await fetch(`${serverUrl}/api/me`, {
      headers: sessionHeaders(sessionCookie),
      // Native: do not combine the secure-store session with the native/WebView cookie jar.
      credentials: fetchCredentials,
    });
    if (res.status === 401) return { _tag: "expired" };
    if (!res.ok) return { _tag: "failed", error: `Server returned ${res.status}` };
    const user: Me = await res.json();
    // Signing in never depends on the box list: when it cannot be read, the box state already held stays.
    const boxes = await createApiClient(serverUrl, sessionCookie, null, sessionEpoch)
      .boxes()
      .catch(() => null);
    return { _tag: "signed-in", user, boxes };
  } catch (e) {
    return {
      _tag: "failed",
      error: `Cannot reach server: ${e instanceof Error ? e.message : String(e)}`,
    };
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

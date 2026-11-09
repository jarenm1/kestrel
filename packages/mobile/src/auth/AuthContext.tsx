import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { storage } from "@/lib/storage";
import type { BoxList, ManagedBox, Me, UserBox } from "@cloudagents/protocol";
import { createApiClient, onUnauthorized, type ActiveBox } from "@/api/client";
import { fetchCredentials, hostOrigin } from "@/auth/session";
import {
  boxesLoaded,
  checkFailed,
  checking,
  expired,
  initialAuthState,
  launched,
  noSession,
  signedIn,
  signedOut,
  type AuthState,
} from "@/auth/sessionState";

const SERVER_URL_KEY = "kestrel_server_url";
const SESSION_COOKIE_KEY = "kestrel_session";
const DEFAULT_SERVER_URL = "https://app.kestrel-agent.com";
/** Served by the app host (web): the browser holds the session cookie, so there is always a session to check. */
const browserSession = hostOrigin !== null;

function sessionHeaders(sessionCookie: string | null): Record<string, string> {
  return sessionCookie ? { Cookie: `session=${sessionCookie}` } : {};
}

export type CheckSessionOptions = {
  /** Refresh without replacing the workspace with the loading screen (used on foreground). */
  readonly quiet?: boolean;
  /** The URL and cookie the check must use; defaults to the current state. */
  readonly serverUrl?: string | null;
  readonly sessionCookie?: string | null;
};

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
  // The current state for the stable callbacks below, and the attempt that may still write the session. A later
  // expiry or sign-out bumps the attempt, so a check that was already in flight cannot sign the user back in.
  const stateRef = useRef(state);
  stateRef.current = state;
  const attempt = useRef(0);

  const activeBox = useMemo(
    () => resolveActiveBox(state.boxes, state.activeBoxId, state.managedBox),
    [state.boxes, state.activeBoxId, state.managedBox]
  );
  const applyBoxList = useCallback((list: BoxList) => {
    setState((s) => boxesLoaded(s, list));
  }, []);

  /**
   * The control plane rejected the session. This is terminal until the user signs in again: the stored cookie is
   * gone, requests stop, and the app shows sign-in instead of a loading or empty workspace.
   */
  const expire = useCallback(async () => {
    attempt.current += 1;
    try {
      await storage.deleteItem(SESSION_COOKIE_KEY);
    } catch {
      // A failed delete must not leave the app claiming a live session; the server has already refused it.
    }
    await queryClient.cancelQueries();
    queryClient.clear();
    setState(expired);
  }, [queryClient]);

  const checkSession = useCallback(
    async (options: CheckSessionOptions = {}) => {
      const serverUrl = options.serverUrl !== undefined ? options.serverUrl : stateRef.current.serverUrl;
      const sessionCookie = options.sessionCookie !== undefined ? options.sessionCookie : stateRef.current.sessionCookie;
      if (serverUrl === null) {
        // Nothing can be checked, and a spinner would never end. A device without a session is simply signed out.
        setState(noSession);
        return;
      }
      if (sessionCookie === null && !browserSession) {
        // Nothing to check. Keep the expiry notice until the user signs in again; a plain launch starts signed out.
        if (!stateRef.current.expired) setState(noSession);
        return;
      }
      if (options.quiet !== true) setState((s) => checking(s, sessionCookie));
      const checked = ++attempt.current;
      await fetchMe({
        serverUrl,
        sessionCookie,
        wasSignedIn: stateRef.current.user !== null || stateRef.current.expired,
        setState,
        applyBoxList,
        expire,
        isCurrent: () => attempt.current === checked,
      });
    },
    [applyBoxList, expire]
  );

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
        await checkSession({ serverUrl: urlToUse, sessionCookie: savedCookie });
      } catch {
        if (active) setState(noSession);
      }
    })();
    return () => {
      active = false;
    };
  }, [checkSession]);

  // Any control-plane call rejected with 401 means the session is expired, wherever the user is in the app.
  useEffect(() => onUnauthorized(() => void expire()), [expire]);

  // A resumed app rechecks the session: it may have expired while the app was in the background.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void checkSession({ quiet: true });
    });
    return () => subscription.remove();
  }, [checkSession]);

  const setServerUrl = useCallback(async (url: string) => {
    const cleaned = url.replace(/\/+$/, "");
    await storage.setItem(SERVER_URL_KEY, cleaned);
    setState((s) => ({ ...s, serverUrl: cleaned, error: null }));
  }, []);

  const setSessionCookie = useCallback(
    async (cookie: string) => {
      await storage.setItem(SESSION_COOKIE_KEY, cookie);
      setState((s) => checking(s, cookie));
      await checkSession({ sessionCookie: cookie });
    },
    [checkSession]
  );

  const setUser = useCallback((user: Me) => {
    setState((s) => signedIn(s, user));
  }, []);

  const signOut = useCallback(async () => {
    if (stateRef.current.serverUrl !== null && (stateRef.current.sessionCookie !== null || browserSession)) {
      try {
        await fetch(`${stateRef.current.serverUrl}/auth/logout`, {
          method: "POST",
          // Native: the explicit session header is authoritative; RN otherwise merges in WebView cookies.
          credentials: fetchCredentials,
          headers: sessionHeaders(stateRef.current.sessionCookie),
        });
      } catch {
        // Ignore logout errors
      }
    }
    attempt.current += 1;
    await storage.deleteItem(SESSION_COOKIE_KEY);
    await queryClient.cancelQueries();
    queryClient.clear();
    setState(signedOut);
  }, [queryClient]);

  const setActiveBox = useCallback(
    async (boxId: string | null) => {
      const { serverUrl, sessionCookie } = stateRef.current;
      if (serverUrl === null) throw new Error("Server URL is not set");
      const list = await createApiClient(serverUrl, sessionCookie, null).setActiveBox(boxId);
      applyBoxList(list);
    },
    [applyBoxList]
  );

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

interface FetchMeOptions {
  readonly serverUrl: string;
  readonly sessionCookie: string | null;
  /** The app believed the user was signed in: a 401 is an expiry, not a first visit with no cookie. */
  readonly wasSignedIn: boolean;
  readonly setState: React.Dispatch<React.SetStateAction<AuthState>>;
  readonly applyBoxList: (list: BoxList) => void;
  readonly expire: () => Promise<void>;
  /** False once a later expiry or sign-out superseded this check; its result must not restore the session. */
  readonly isCurrent: () => boolean;
}

async function fetchMe({
  serverUrl,
  sessionCookie,
  wasSignedIn,
  setState,
  applyBoxList,
  expire,
  isCurrent,
}: FetchMeOptions) {
  try {
    const res = await fetch(`${serverUrl}/api/me`, {
      headers: sessionHeaders(sessionCookie),
      // Native: do not combine the secure-store session with the native/WebView cookie jar.
      credentials: fetchCredentials,
    });
    if (!isCurrent()) return;
    if (res.status === 401) {
      // A stored cookie or a user the app already had makes this an expiry; a first visit with no session does not.
      if (sessionCookie !== null || wasSignedIn) await expire();
      else setState(noSession);
      return;
    }
    if (!res.ok) {
      setState((s) => checkFailed(s, `Server returned ${res.status}`));
      return;
    }
    const user: Me = await res.json();
    if (!isCurrent()) return;
    // Signing in never depends on the box list: when it cannot be read, the box state already held stays.
    const boxes = await createApiClient(serverUrl, sessionCookie, null)
      .boxes()
      .catch(() => null);
    if (!isCurrent()) return;
    if (boxes !== null) applyBoxList(boxes);
    setState((s) => signedIn(s, user));
  } catch (e) {
    if (!isCurrent()) return;
    setState((s) =>
      checkFailed(s, `Cannot reach server: ${e instanceof Error ? e.message : String(e)}`)
    );
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

import type { BoxList, ManagedBox, Me, UserBox } from "@cloudagents/protocol";

/**
 * Where the app is with the control plane's session. `loading` covers the initial check; `expired` is a terminal
 * answer from the server (the cookie is gone), distinct from a signed-out device, a network failure and a signed-in
 * user. Only this module's writers move between them.
 */
export interface AuthState {
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
  /** The control plane rejected the session: the app shows sign-in, not a spinner or an empty workspace. */
  expired: boolean;
  /** Last auth error */
  error: string | null;
}

/** A fresh launch: nothing is known until the saved session (if any) is checked. */
export const initialAuthState: AuthState = {
  serverUrl: null,
  sessionCookie: null,
  user: null,
  loading: true,
  error: null,
  expired: false,
  boxes: [],
  activeBoxId: null,
  managedBox: null,
};

/** The saved server URL and session are loaded; the check that follows decides whether they are live. */
export const launched = (state: AuthState, serverUrl: string, sessionCookie: string | null): AuthState => ({
  ...state,
  serverUrl,
  sessionCookie,
  loading: true,
  error: null,
});

/** The session was checked and the user is signed in. */
export const signedIn = (state: AuthState, user: Me): AuthState => ({
  ...state,
  user,
  loading: false,
  error: null,
  expired: false,
});

/**
 * The control plane answered 401: the session is expired. The stored cookie is gone (the caller clears it) and so is
 * everything cached under it. `expired` stays set so the app can explain why the sign-in screen came back.
 */
export const expired = (state: AuthState): AuthState => ({
  ...state,
  sessionCookie: null,
  user: null,
  loading: false,
  error: null,
  expired: true,
  boxes: [],
  activeBoxId: null,
  managedBox: null,
});

/** The check failed for a reason other than the session (the server is unreachable, or it answered an error). */
export const checkFailed = (state: AuthState, error: string): AuthState => ({
  ...state,
  loading: false,
  error,
});

/** No session to check: the device has no cookie (native) and the browser has none (web). This is not an expiry. */
export const noSession = (state: AuthState): AuthState => ({
  ...state,
  user: null,
  loading: false,
  error: null,
  expired: false,
});

/** A new session was captured (or a server URL was set) and its check is starting. */
export const checking = (state: AuthState, sessionCookie: string | null): AuthState => ({
  ...state,
  sessionCookie,
  loading: true,
  error: null,
  expired: false,
});

/** The box list arrived beside a successful `/api/me`. */
export const boxesLoaded = (state: AuthState, list: BoxList): AuthState => ({
  ...state,
  boxes: list.boxes,
  activeBoxId: list.activeBoxId,
  managedBox: list.managedBox,
});

/** The user signed out deliberately (or the app is starting from zero): no user, no cached boxes, not an expiry. */
export const signedOut = (state: AuthState): AuthState => ({
  ...state,
  sessionCookie: null,
  user: null,
  loading: false,
  error: null,
  expired: false,
  boxes: [],
  activeBoxId: null,
  managedBox: null,
});

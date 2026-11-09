import type { BoxList, Me } from "@cloudagents/protocol";
import {
  boxesLoaded,
  checkFailed,
  checking,
  expired,
  expiringEpoch,
  noSession,
  signedIn,
  signedOut,
  startedSession,
  type AuthState,
} from "@/auth/sessionState";

/** The control plane's answer for one session check. */
export type CheckOutcome =
  | { readonly _tag: "signed-in"; readonly user: Me; readonly boxes: BoxList | null }
  | { readonly _tag: "expired" }
  | { readonly _tag: "failed"; readonly error: string };

export interface CheckSessionOptions {
  /** Refresh without replacing the workspace with the loading screen (used on foreground). */
  readonly quiet?: boolean;
  /** The URL and cookie the check must use; defaults to the current state. */
  readonly serverUrl?: string | null;
  readonly sessionCookie?: string | null;
}

/**
 * What the machine touches outside itself. The provider supplies React state, the real `/api/me` exchange, storage and
 * the query cache; tests supply the same ports in memory.
 */
export interface SessionPorts {
  readonly state: () => AuthState;
  readonly update: (change: (state: AuthState) => AuthState) => void;
  /** The web build always has a browser-held session, so it checks even without a stored cookie. */
  readonly browserSession: boolean;
  readonly check: (
    serverUrl: string,
    sessionCookie: string | null,
    sessionEpoch: number
  ) => Promise<CheckOutcome>;
  readonly logout: (serverUrl: string, sessionCookie: string | null) => Promise<void>;
  readonly removeStoredSession: () => Promise<void>;
  /** Cancels in-flight queries and clears the cache. */
  readonly resetQueries: () => Promise<void>;
}

export interface SessionMachine {
  /** The session generation new clients should capture. */
  sessionEpoch(): number;
  check(options?: CheckSessionOptions): Promise<void>;
  /** A 401 report; only the session generation that made the request may expire the app. */
  expire(reportedEpoch: number): Promise<void>;
  /** A new credential starts a new generation and is checked. */
  startSession(serverUrl: string | null, sessionCookie: string): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * The one writer of the provider's session phases. A check is superseded by any later check, a new session, an
 * expiry or a sign-out (the attempt guard), so an in-flight `/api/me` can never sign a user back in. Expiry is
 * generation-guarded twice: before it starts and after its awaits, so a session that started while the cookie and
 * queries were being cleared wins.
 */
export const createSessionMachine = (ports: SessionPorts): SessionMachine => {
  let attempt = 0;
  let epoch = ports.state().sessionEpoch;

  const expire = async (reportedEpoch: number): Promise<void> => {
    const next = expiringEpoch(reportedEpoch, epoch);
    if (next === null) return;
    attempt += 1;
    try {
      await ports.removeStoredSession();
    } catch {
      // A failed delete must not leave the app claiming a live session; the server has already refused it.
    }
    await ports.resetQueries();
    if (expiringEpoch(reportedEpoch, epoch) === null) return;
    epoch = next;
    ports.update((state) => expired(state, next));
  };

  const check = async (options: CheckSessionOptions = {}): Promise<void> => {
    const before = ports.state();
    const serverUrl = options.serverUrl !== undefined ? options.serverUrl : before.serverUrl;
    const sessionCookie =
      options.sessionCookie !== undefined ? options.sessionCookie : before.sessionCookie;
    if (serverUrl === null) {
      // Nothing can be checked, and a spinner would never end. A device without a session is simply signed out.
      ports.update(noSession);
      return;
    }
    if (sessionCookie === null && !ports.browserSession) {
      // Nothing to check. Keep the expiry notice until the user signs in again; a plain launch starts signed out.
      if (!before.expired) ports.update(noSession);
      return;
    }
    if (options.quiet !== true) ports.update((state) => checking(state, sessionCookie));
    const checked = ++attempt;
    const reportedEpoch = epoch;
    const outcome = await ports.check(serverUrl, sessionCookie, reportedEpoch);
    // A later check, expiry or sign-out superseded this one. Its answer is about a session the app has left.
    if (attempt !== checked) return;

    switch (outcome._tag) {
      case "signed-in": {
        const list = outcome.boxes;
        if (list !== null) ports.update((state) => boxesLoaded(state, list));
        ports.update((state) => signedIn(state, outcome.user));
        return;
      }
      case "expired":
        // A stored cookie or a user the app already had makes this an expiry; a first visit with no session does not.
        if (sessionCookie !== null || before.user !== null || before.expired) {
          await expire(reportedEpoch);
        } else {
          ports.update(noSession);
        }
        return;
      case "failed":
        ports.update((state) => checkFailed(state, outcome.error));
    }
  };

  const startSession = async (serverUrl: string | null, sessionCookie: string): Promise<void> => {
    const next = epoch + 1;
    epoch = next;
    ports.update((state) => startedSession(state, sessionCookie, next));
    await check({ serverUrl, sessionCookie });
  };

  const signOut = async (): Promise<void> => {
    const before = ports.state();
    if (before.serverUrl !== null && (before.sessionCookie !== null || ports.browserSession)) {
      await ports.logout(before.serverUrl, before.sessionCookie).catch(() => undefined);
    }
    attempt += 1;
    epoch += 1;
    await ports.removeStoredSession();
    await ports.resetQueries();
    // A check that started while the session was being cleared is superseded too.
    attempt += 1;
    ports.update((state) => signedOut(state, epoch));
  };

  return { sessionEpoch: () => epoch, check, expire, startSession, signOut };
};

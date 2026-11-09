import { expect, test } from "bun:test";
import type { BoxList, Me } from "@cloudagents/protocol";
import { initialAuthState, type AuthState } from "./sessionState";
import { createSessionMachine, type CheckOutcome, type SessionMachine, type SessionPorts } from "./sessionMachine";

const user: Me = { login: "octocat", name: null, avatarUrl: "", operator: false, nestEnabled: false };
const other: Me = { ...user, login: "other" };
const boxes: BoxList = { boxes: [], activeBoxId: null, managedBox: null };

const live = (overrides: Partial<AuthState> = {}): AuthState => ({
  ...initialAuthState,
  serverUrl: "https://app.example",
  sessionCookie: "cookie-a",
  user,
  loading: false,
  sessionEpoch: 1,
  ...overrides,
});

interface Harness {
  readonly ports: MutablePorts;
  readonly machine: SessionMachine;
  state(): AuthState;
  removed(): number;
  resets(): number;
  logouts(): number;
}

type MutablePorts = { -readonly [K in keyof SessionPorts]: SessionPorts[K] };

const harness = (initial: AuthState = live()): Harness => {
  let state = initial;
  let removed = 0;
  let resets = 0;
  let logouts = 0;
  const ports: MutablePorts = {
    state: () => state,
    update: (change) => {
      state = change(state);
    },
    browserSession: false,
    check: async () => {
      throw new Error("check port not set");
    },
    logout: async () => {
      logouts += 1;
    },
    removeStoredSession: async () => {
      removed += 1;
    },
    resetQueries: async () => {
      resets += 1;
    },
  };
  return {
    ports,
    machine: createSessionMachine(ports),
    state: () => state,
    removed: () => removed,
    resets: () => resets,
    logouts: () => logouts,
  };
};

test("an in-flight check cannot sign the user back in after the session expires", async () => {
  const h = harness();
  const answer = Promise.withResolvers<CheckOutcome>();
  h.ports.check = () => answer.promise;

  const checking = h.machine.check();
  await h.machine.expire(1);
  expect(h.state()).toMatchObject({ expired: true, user: null, sessionEpoch: 2 });

  answer.resolve({ _tag: "signed-in", user, boxes });
  await checking;
  expect(h.state()).toMatchObject({ expired: true, user: null, sessionEpoch: 2 });
});

test("a foreground check refreshes quietly and a failed one keeps the signed-in user", async () => {
  const h = harness();
  const answer = Promise.withResolvers<CheckOutcome>();
  const seen: { current: { serverUrl: string; cookie: string | null; epoch: number } | null } = {
    current: null,
  };
  h.ports.check = (serverUrl, cookie, epoch) => {
    seen.current = { serverUrl, cookie, epoch };
    return answer.promise;
  };

  const checking = h.machine.check({ quiet: true });
  // Nothing replaced the workspace with a loading screen, and the check used the live session.
  expect(h.state().loading).toBe(false);
  expect(seen.current).toEqual({ serverUrl: "https://app.example", cookie: "cookie-a", epoch: 1 });

  answer.resolve({ _tag: "failed", error: "Cannot reach server" });
  await checking;
  expect(h.state()).toMatchObject({ user, loading: false, error: "Cannot reach server", expired: false });
});

test("a session that starts while expiry clears the cookie wins, before and after the awaits", async () => {
  const h = harness();
  const removal = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<CheckOutcome>();
  h.ports.removeStoredSession = () => removal.promise;
  h.ports.check = () => answer.promise;

  const expiring = h.machine.expire(1);
  const starting = h.machine.startSession("https://app.example", "cookie-b");
  expect(h.state()).toMatchObject({ sessionCookie: "cookie-b", sessionEpoch: 2, user: null });

  answer.resolve({ _tag: "signed-in", user: other, boxes });
  await starting;
  expect(h.state()).toMatchObject({ user: other, expired: false, sessionEpoch: 2 });

  removal.resolve();
  await expiring;
  // The late expiry re-checked the generation after its awaits and did not sign the new user out.
  expect(h.state()).toMatchObject({ user: other, expired: false, sessionEpoch: 2, sessionCookie: "cookie-b" });
  expect(h.removed() + h.resets()).toBeGreaterThan(0);
});

test("a 401 report from an older session generation changes nothing", async () => {
  const h = harness();
  await h.machine.expire(0);
  expect(h.state()).toMatchObject({ user, expired: false, sessionEpoch: 1 });
  expect(h.removed()).toBe(0);
});

test("a new credential starts a new generation, clears the old user, and is checked", async () => {
  const h = harness();
  const answer = Promise.withResolvers<CheckOutcome>();
  h.ports.check = () => answer.promise;

  const starting = h.machine.startSession("https://app.example", "cookie-b");
  expect(h.state()).toMatchObject({
    sessionCookie: "cookie-b",
    sessionEpoch: 2,
    user: null,
    loading: true,
    expired: false,
  });
  answer.resolve({ _tag: "signed-in", user: other, boxes });
  await starting;
  expect(h.state()).toMatchObject({ user: other, sessionCookie: "cookie-b", sessionEpoch: 2 });
});

test("signing out supersedes a check that was already in flight", async () => {
  const h = harness();
  const answer = Promise.withResolvers<CheckOutcome>();
  h.ports.check = () => answer.promise;

  const checking = h.machine.check();
  await h.machine.signOut();
  expect(h.logouts()).toBe(1);
  expect(h.state()).toMatchObject({ user: null, error: null, expired: false, sessionEpoch: 2 });

  answer.resolve({ _tag: "signed-in", user, boxes });
  await checking;
  expect(h.state()).toMatchObject({ user: null, expired: false, sessionEpoch: 2 });
});

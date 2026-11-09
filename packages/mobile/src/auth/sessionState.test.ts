import { expect, test } from "bun:test";
import type { BoxList, Me, UserBox } from "@cloudagents/protocol";
import {
  boxesLoaded,
  checkFailed,
  checking,
  expired,
  expiringEpoch,
  initialAuthState,
  launched,
  noSession,
  signedIn,
  signedOut,
  startedSession,
  type AuthState,
} from "./sessionState";

const user: Me = { login: "octocat", name: null, avatarUrl: "", operator: false, nestEnabled: false };
const box: UserBox = { id: "box-1", name: "Box 1", url: "https://box.example", createdAt: "2026-01-01T00:00:00Z" };
const boxList: BoxList = { boxes: [box], activeBoxId: "box-1", managedBox: null };

const live: AuthState = {
  ...initialAuthState,
  serverUrl: "https://app.example",
  sessionCookie: "cookie",
  user,
  loading: false,
  sessionEpoch: 3,
  boxes: [box],
  activeBoxId: "box-1",
};

test("a 401 is an expired state, not a load failure and not a signed-out device", () => {
  const next = expired(live, 4);
  expect(next.expired).toBe(true);
  expect(next.loading).toBe(false);
  expect(next.error).toBeNull();
  expect(next.user).toBeNull();
  expect(next.sessionCookie).toBeNull();
  expect(next.sessionEpoch).toBe(4);
  expect(next.boxes).toEqual([]);
  expect(next.activeBoxId).toBeNull();
  expect(next.managedBox).toBeNull();
  expect(next).not.toEqual(noSession(live));
});

test("a signed-in check clears expiry and a failed check does not claim one", () => {
  const back = signedIn(expired(live, 4), user);
  expect(back).toMatchObject({ expired: false, loading: false, user, sessionEpoch: 4 });
  const offline = checkFailed(live, "Cannot reach server");
  expect(offline.expired).toBe(false);
  expect(offline.loading).toBe(false);
  expect(offline.user).toEqual(user);
  expect(offline.error).toBe("Cannot reach server");
});

test("launching and checking keep expiry out of the loading state", () => {
  const start = launched(initialAuthState, "https://app.example", "cookie");
  expect(start).toMatchObject({ serverUrl: "https://app.example", sessionCookie: "cookie", loading: true });
  expect(start.expired).toBe(false);
  const again = checking(expired(live, 4), "new-cookie");
  expect(again).toMatchObject({ loading: true, expired: false, sessionCookie: "new-cookie", sessionEpoch: 4 });
});

test("only the current session generation may expire, before and after the awaits", () => {
  // The 401 matches the session the app is on: it advances the epoch and expires.
  expect(expiringEpoch(3, 3)).toBe(4);
  // A late 401 from session 3 arrives after the user signed in as generation 4: it must not expire it.
  expect(expiringEpoch(3, 4)).toBeNull();
  // Re-checking after the awaits sees the same rule: a session that started meanwhile wins.
  expect(expiringEpoch(4, 4)).toBe(5);
  expect(expiringEpoch(4, 5)).toBeNull();
});

test("a new credential starts a new generation and drops the previous user's state", () => {
  const next = startedSession(live, "other-cookie", 4);
  expect(next).toMatchObject({
    sessionCookie: "other-cookie",
    sessionEpoch: 4,
    user: null,
    loading: true,
    expired: false,
    boxes: [],
    activeBoxId: null,
    managedBox: null,
  });
});

test("the box list is applied beside a live session and dropped by expiry and sign-out", () => {
  expect(boxesLoaded(live, boxList)).toMatchObject({ boxes: [box], activeBoxId: "box-1", managedBox: null });
  expect(expired(boxesLoaded(live, boxList), 4).boxes).toEqual([]);
  expect(signedOut(boxesLoaded(live, boxList), 4)).toMatchObject({
    expired: false,
    user: null,
    sessionCookie: null,
    sessionEpoch: 4,
    boxes: [],
  });
});

import { expect, test } from "bun:test";
import type { BoxList, Me, UserBox } from "@cloudagents/protocol";
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
  boxes: [box],
  activeBoxId: "box-1",
};

test("a 401 is an expired state, not a load failure and not a signed-out device", () => {
  const next = expired(live);
  expect(next.expired).toBe(true);
  expect(next.loading).toBe(false);
  expect(next.error).toBeNull();
  expect(next.user).toBeNull();
  expect(next.sessionCookie).toBeNull();
  expect(next.boxes).toEqual([]);
  expect(next.activeBoxId).toBeNull();
  expect(next.managedBox).toBeNull();
  expect(next).not.toEqual(noSession(live));
});

test("a signed-in check clears expiry and a failed check does not claim one", () => {
  const back = signedIn(expired(live), user);
  expect(back).toMatchObject({ expired: false, loading: false, user });
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
  const again = checking(expired(live), "new-cookie");
  expect(again).toMatchObject({ loading: true, expired: false, sessionCookie: "new-cookie" });
});

test("the box list is applied beside a live session and dropped by expiry and sign-out", () => {
  expect(boxesLoaded(live, boxList)).toMatchObject({ boxes: [box], activeBoxId: "box-1", managedBox: null });
  expect(expired(boxesLoaded(live, boxList)).boxes).toEqual([]);
  expect(signedOut(boxesLoaded(live, boxList))).toMatchObject({
    expired: false,
    user: null,
    sessionCookie: null,
    boxes: [],
  });
});

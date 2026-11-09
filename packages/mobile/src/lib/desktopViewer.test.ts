import { expect, test } from "bun:test";
import { embedEvent, initialViewerView, reduceViewer, type ViewerAction } from "./desktopViewer";

const apply = (actions: readonly ViewerAction[]) =>
  actions.reduce(reduceViewer, initialViewerView);

test("only the embed's own messages are parsed", () => {
  expect(embedEvent({ type: "kestrel-desktop", event: "status", state: "live" })).toEqual({
    event: "status",
    state: "live",
  });
  expect(embedEvent({ type: "kestrel-desktop", event: "auth-expired" })).toEqual({ event: "auth-expired" });
  expect(embedEvent({ type: "kestrel-desktop", event: "unreachable" })).toEqual({ event: "unreachable" });
  expect(embedEvent({ type: "other", event: "status", state: "live" })).toBeNull();
  expect(embedEvent({ type: "kestrel-desktop", event: "status" })).toBeNull();
  expect(embedEvent("kestrel-desktop")).toBeNull();
});

test("a new embed URL drops the previous stream's status and error", () => {
  const before = apply([
    { _tag: "message", message: { event: "status", state: "live" } },
    { _tag: "failed", reason: "sign-in expired" },
  ]);
  expect(before).toMatchObject({ state: null, error: "sign-in expired" });
  expect(reduceViewer(before, { _tag: "embedChanged" })).toEqual(initialViewerView);
});

test("unreachable and auth-expired stay distinct", () => {
  const unreachable = reduceViewer(initialViewerView, {
    _tag: "message",
    message: { event: "unreachable" },
  });
  expect(unreachable).toMatchObject({ unreachable: true, error: null });

  const expired = reduceViewer(unreachable, {
    _tag: "message",
    message: { event: "auth-expired" },
  });
  expect(expired).toMatchObject({ unreachable: false, error: null });

  const failed = reduceViewer(expired, { _tag: "failed", reason: "fresh sign-in refused" });
  expect(failed).toMatchObject({ unreachable: false, error: "fresh sign-in refused" });

  // A status post means the stream is alive again: it clears both paths.
  expect(apply([
    { _tag: "message", message: { event: "status", state: "connecting" } },
    { _tag: "message", message: { event: "status", state: "live" } },
  ])).toMatchObject({ state: "live", unreachable: false, error: null });
});

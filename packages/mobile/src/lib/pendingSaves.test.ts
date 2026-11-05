import { expect, test } from "bun:test";
import { pendingSaves, trackSave, trackSaveQueue } from "./pendingSaves";
import { createSaveQueue } from "./saveQueue";

test("a reopened form sees the previous form's save until it settles", async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const queue = createSaveQueue((value: string) => promise.then(() => value));

  queue.push("newest");
  trackSaveQueue("box-a", queue);
  const pending = pendingSaves("box-a");
  expect(pending).toBeDefined();

  resolve("newest");
  await pending;
  await Promise.resolve();
  expect(pendingSaves("box-a")).toBeUndefined();
});

test("waiting is per box, so another box's form does not block", async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const queue = createSaveQueue((value: string) => promise.then(() => value));
  queue.push("first box");
  trackSaveQueue("box-a", queue);

  expect(pendingSaves("box-a")).toBeDefined();
  expect(pendingSaves("box-b")).toBeUndefined();
  resolve("first box");
  await pendingSaves("box-a");
});

test("a mutation write is reported until it settles", async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  trackSave("mutation-box", promise);
  const pending = pendingSaves("mutation-box");
  expect(pending).toBeDefined();
  resolve("saved");
  await pending;
  await Promise.resolve();
  expect(pendingSaves("mutation-box")).toBeUndefined();
});

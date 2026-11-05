import { expect, test } from "bun:test";
import { createSaveQueue } from "./saveQueue";

/** A save that holds its first call in flight until the test releases it; later calls resolve at once. */
function firstSaveControlled() {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const save = (value: string) => {
    calls.push(value);
    if (calls.length > 1) return Promise.resolve(value);
    const { promise, resolve } = Promise.withResolvers<void>();
    release = resolve;
    return promise.then(() => value);
  };
  return {
    calls,
    release: () => {
      if (release === undefined) throw new Error("no save is in flight");
      release();
    },
    save,
  };
}

test("rapid changes while a save is in flight collapse into the latest snapshot", async () => {
  const { calls, release, save } = firstSaveControlled();
  const saved: string[] = [];
  const queue = createSaveQueue(save, { onSaved: (value) => saved.push(value) });

  queue.push("first");
  queue.push("second");
  queue.push("third");
  expect(calls).toEqual(["first"]);

  release();
  await queue.idle();
  expect(calls).toEqual(["first", "third"]);
  expect(saved).toEqual(["first", "third"]);
});

test("a failed save does not block the snapshot queued behind it", async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const queue = createSaveQueue(
    async (value: string) => {
      calls.push(value);
      if (value === "first") throw new Error("box rejected it");
      return value;
    },
    { onError: (error) => errors.push(String(error)) }
  );

  queue.push("first");
  queue.push("second");
  await queue.idle();
  expect(calls).toEqual(["first", "second"]);
  expect(errors).toEqual(["Error: box rejected it"]);
});

test("idle waits for a save pushed while the queue drains", async () => {
  const { calls, release, save } = firstSaveControlled();
  const queue = createSaveQueue(save);

  queue.push("first");
  const idle = queue.idle();
  queue.push("second");
  release();
  await idle;
  expect(calls).toEqual(["first", "second"]);
  expect(queue.busy()).toBe(false);
});

test("a queue keeps its own destination after the form that made it is gone", async () => {
  // Each queue stands for one mounted form, pinned to one box; unmounting must not redirect its writes.
  const first: string[] = [];
  const second: string[] = [];
  const firstQueue = createSaveQueue(async (value: string) => {
    first.push(value);
    return value;
  });
  const secondQueue = createSaveQueue(async (value: string) => {
    second.push(value);
    return value;
  });

  firstQueue.push("first box edit");
  secondQueue.push("second box edit");
  await Promise.all([firstQueue.idle(), secondQueue.idle()]);
  expect(first).toEqual(["first box edit"]);
  expect(second).toEqual(["second box edit"]);
});

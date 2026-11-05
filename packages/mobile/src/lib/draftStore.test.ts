import { describe, expect, test } from "bun:test";
import { createDraftStore } from "./draftStore";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    deleteItem: async (key: string) => { values.delete(key); },
  };
}

describe("draft persistence across composer mounts", () => {
  test("a remount waits for queued edits and consumption before reading, then keeps newer edits", async () => {
    const storage = memoryStorage({ thread: "/usage old draft" });
    const editStarted = Promise.withResolvers<void>();
    const editFinished = Promise.withResolvers<void>();
    const consumeStarted = Promise.withResolvers<void>();
    const consumeFinished = Promise.withResolvers<void>();
    const drafts = createDraftStore({
      ...storage,
      setItem: async (key, value) => {
        if (value.startsWith("/usage")) {
          editStarted.resolve();
          await editFinished.promise;
        } else if (value === "latest draft") {
          consumeStarted.resolve();
          await consumeFinished.promise;
        }
        await storage.setItem(key, value);
      },
    });

    const oldMountEdit = drafts.write("thread", "/usage latest draft");
    await editStarted.promise;
    const consumed = drafts.write("thread", "latest draft");
    let remountReady = false;
    const remount = drafts.read("thread").then((text) => { remountReady = true; return text; });
    editFinished.resolve();
    await consumeStarted.promise;
    expect(remountReady).toBe(false);
    expect(storage.values.get("thread")).toBe("/usage latest draft");
    consumeFinished.resolve();
    await consumed;
    expect(await remount).toBe("latest draft");
    await drafts.write("thread", "new text after Back");
    await oldMountEdit;
    expect(await drafts.read("thread")).toBe("new text after Back");
  });

  test("consuming an entire command waits for deletion before a new mount reads", async () => {
    const storage = memoryStorage({ thread: "/usage" });
    const deleting = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    const drafts = createDraftStore({
      ...storage,
      deleteItem: async (key) => {
        deleting.resolve();
        await deleted.promise;
        await storage.deleteItem(key);
      },
    });
    const consumed = drafts.write("thread", "");
    await deleting.promise;
    const remount = drafts.read("thread");
    // Another draft must not be blocked by this draft's delayed SecureStore operation.
    await drafts.write("other-thread", "independent draft");
    expect(await drafts.read("other-thread")).toBe("independent draft");
    deleted.resolve();
    await consumed;
    expect(await remount).toBeNull();
  });

  test("a failed write rejects its caller without blocking later reads and edits", async () => {
    const storage = memoryStorage({ thread: "saved draft" });
    const failure = new Error("SecureStore write failed");
    let fail = true;
    const drafts = createDraftStore({
      ...storage,
      setItem: async (key, value) => {
        if (fail) { fail = false; throw failure; }
        await storage.setItem(key, value);
      },
    });
    await expect(drafts.write("thread", "unsaved draft")).rejects.toBe(failure);
    expect(await drafts.read("thread")).toBe("saved draft");
    await drafts.write("thread", "recovered draft");
    expect(await drafts.read("thread")).toBe("recovered draft");
  });
});

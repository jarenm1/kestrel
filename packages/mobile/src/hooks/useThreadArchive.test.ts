import { expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { Task } from "@cloudagents/protocol";
import { createApiClient, type ApiClient } from "../api/client";
import { boxKeys } from "../api/queries";
import { threadArchiveOptions } from "./useThreadArchive";

const task = (title: string): Task => ({
  id: "same-id", owner: "owner", title, status: "idle", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", checkouts: [],
});

const origin = createApiClient("https://control.example", "session", { id: "origin", url: "https://origin.example" });
const current = createApiClient("https://control.example", "session", { id: "current", url: "https://current.example" });

for (const op of ["archive", "unarchive"] as const) {
  test(`${op} response lands in the box that sent it when the box changes mid-request`, async () => {
    const cache = new QueryClient();
    cache.setQueryData(boxKeys(origin.boxScope).tasks, [task("origin")]);
    cache.setQueryData(boxKeys(current.boxScope).tasks, [task("current")]);

    let respond!: (updated: Task) => void;
    const response = new Promise<Task>((resolve) => {
      respond = resolve;
    });
    // The origin box's client, with its archive and unarchive requests held until the test resolves them.
    const held: ApiClient = { ...origin, archiveTask: () => response, unarchiveTask: () => response };

    const observer = new MutationObserver(cache, threadArchiveOptions(cache)[op]);
    const request = observer.mutate({ api: held, taskId: "same-id" });

    // The box switches while the request is pending: the screen re-renders and hands the observer its new options.
    observer.setOptions(threadArchiveOptions(cache)[op]);
    respond(task("updated"));
    await request;

    expect(cache.getQueryData<Task[]>(boxKeys(origin.boxScope).tasks)?.[0]?.title).toBe("updated");
    expect(cache.getQueryData<Task[]>(boxKeys(current.boxScope).tasks)?.[0]?.title).toBe("current");
    expect(cache.getQueryData<Task>(boxKeys(current.boxScope).task("same-id"))).toBeUndefined();
  });
}

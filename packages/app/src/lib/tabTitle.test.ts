import { describe, expect, test } from "bun:test"
import type { Task } from "@cloudagents/protocol"
import { nextFinished, tabTitle, titleThreads } from "./tabTitle"

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task => ({
  id,
  owner: "me",
  title: id,
  status,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  checkouts: [],
  ...extra,
})

/** Feeds snapshots through `nextFinished` the way the hook does and returns the last title. */
function titleAfter(snapshots: readonly Task[][], openTaskId?: string): string {
  let finished: ReadonlySet<string> = new Set()
  let working: ReadonlySet<string> = new Set()
  let threads = titleThreads([])
  for (const tasks of snapshots) {
    threads = titleThreads(tasks)
    finished = nextFinished(finished, working, threads, openTaskId)
    working = threads.working
  }
  return tabTitle(threads, finished)
}

describe("tab title", () => {
  test("counts working, waiting and threads that finished while the tab watched", () => {
    expect(
      titleAfter([
        [task("a", "running"), task("b", "running"), task("c", "running"), task("d", "running"), task("e", "idle")],
        [task("a", "running"), task("b", "running"), task("c", "done"), task("d", "failed"), task("e", "needs_input")],
      ]),
    ).toBe("Kestrel • 2 Working, 1 Needs input, 1 Done, 1 Failed")
  })

  test("threads already done on load are not counted", () => {
    expect(titleAfter([[task("a", "done"), task("b", "failed")]])).toBe("Kestrel")
  })

  test("a finished thread stays counted across updates until opened, archived or restarted", () => {
    const finished = [task("a", "running"), task("b", "running"), task("c", "running")]
    const after = [task("a", "done"), task("b", "done"), task("c", "done")]
    expect(titleAfter([finished, after, after])).toBe("Kestrel • 3 Done")
    expect(titleAfter([finished, after], "a")).toBe("Kestrel • 2 Done")
    expect(
      titleAfter([finished, after, [task("a", "done", { archivedAt: "x" }), task("b", "running"), task("c", "done")]]),
    ).toBe("Kestrel • 1 Working, 1 Done")
  })

  test("sub-threads are not counted, matching the sidebar", () => {
    expect(titleAfter([[task("a", "running"), task("b", "running", { spawnedByTaskId: "a" })]])).toBe(
      "Kestrel • 1 Working",
    )
  })
})

import { expect, test } from "bun:test"
import type { Message } from "@cloudagents/protocol"
import { deriveMinimapItems, resolveMinimapCurrentIndex, resolveMinimapIndexFromPointer, resolveMinimapPreview } from "./minimap"

const message = (id: string, role: Message["role"], text: string): Message => ({
  id,
  taskId: "task",
  role,
  text,
  runId: null,
  createdAt: "2026-11-09T10:00:00Z",
})

test("each user message is a turn previewing the last agent reply before the next one", () => {
  const items = deriveMinimapItems([
    message("intro", "agent", "Before any prompt"),
    message("one", "user", "First"),
    message("a", "agent", "Working"),
    message("b", "agent", "Done"),
    message("two", "user", "Second"),
  ])
  expect(items).toEqual([
    { id: "one", userText: "First", assistantText: "Done" },
    { id: "two", userText: "Second", assistantText: null },
  ])
})

test("the preview reads a reply's markdown as plain words", () => {
  const preview = resolveMinimapPreview({ id: "one", userText: "  Fix\n the  bug ", assistantText: "## Done\n\n- **Fixed** [the bug](https://x.y)\n```ts\ncode\n```" })
  expect(preview).toEqual({ userText: "Fix the bug", assistantText: "Done Fixed the bug" })
})

test("the current turn is the first message in view, else the last one above it", () => {
  expect(resolveMinimapCurrentIndex([false, true, true], [true, false, false])).toBe(1)
  expect(resolveMinimapCurrentIndex([false, false, false], [true, true, false])).toBe(1)
  expect(resolveMinimapCurrentIndex([false, false], [false, false])).toBe(null)
})

test("the pointer picks the nearest strip", () => {
  expect(resolveMinimapIndexFromPointer({ itemCount: 5, railTop: 100, railHeight: 40, pointerY: 121 })).toBe(2)
  expect(resolveMinimapIndexFromPointer({ itemCount: 5, railTop: 100, railHeight: 40, pointerY: 0 })).toBe(0)
})

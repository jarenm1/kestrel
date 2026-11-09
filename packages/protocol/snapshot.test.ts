import { describe, expect, test } from "bun:test"
import { mergeSnapshot } from "./src/snapshot"

interface Item {
  readonly id: string
  readonly value: string
}

const item = (id: string, value: string): Item => ({ id, value })
const values = (items: readonly Item[]) => items.map((entry) => `${entry.id}:${entry.value}`)

describe("mergeSnapshot", () => {
  test("the snapshot replaces an entry cached before the fetch", () => {
    const cached = item("a", "old")
    expect(values(mergeSnapshot([item("a", "new")], [cached], new Set([cached])))).toEqual(["a:new"])
  })

  test("an entry written during the fetch wins", () => {
    const before = item("a", "old")
    const written = item("a", "event")
    expect(values(mergeSnapshot([item("a", "snapshot")], [written], new Set([before])))).toEqual(["a:event"])
  })

  test("entries the snapshot lacks stay after the snapshot's own", () => {
    const cached = item("b", "cached")
    expect(values(mergeSnapshot([item("a", "new")], [cached], new Set([cached])))).toEqual(["a:new", "b:cached"])
  })

  test("a cached entry replaces its earlier position when the event wrote it", () => {
    const before = item("a", "old")
    const written = item("a", "event")
    expect(values(mergeSnapshot([item("a", "snapshot"), item("b", "new")], [written], new Set([before])))).toEqual([
      "a:event",
      "b:new",
    ])
  })

  test("an empty cache returns the snapshot in order", () => {
    expect(values(mergeSnapshot([item("a", "1"), item("b", "2")], [], new Set()))).toEqual(["a:1", "b:2"])
  })
})

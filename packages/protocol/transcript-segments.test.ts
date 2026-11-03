import { describe, expect, test } from "bun:test"
import type { Message } from "./src/index"
import { transcriptSegments } from "./src/transcript-segments"

const message = (id: string, role: Message["role"], runId: string | null, afterItems?: number): Message => ({
  id,
  taskId: "t",
  role,
  text: id,
  runId,
  createdAt: id,
  ...(afterItems === undefined ? {} : { afterItems }),
})

describe("transcriptSegments", () => {
  test("a steer splits its run's transcript where it arrived; runs and agent messages stay apart", () => {
    const segments = transcriptSegments([
      message("prompt1", "user", "r1"),
      message("reply1", "agent", "r1"),
      message("prompt2", "user", "r2"),
      message("steer", "user", "r2", 3),
      message("answer", "user", "r2", 7),
    ])
    expect([...segments]).toEqual([
      ["prompt1", { runId: "r1", from: 0, to: null }],
      ["prompt2", { runId: "r2", from: 0, to: 3 }],
      ["steer", { runId: "r2", from: 3, to: 7 }],
      ["answer", { runId: "r2", from: 7, to: null }],
    ])
  })

  test("a message without a recorded position follows the prompt, and positions never go back", () => {
    const segments = transcriptSegments([
      message("prompt", "user", "r"),
      message("old", "user", "r"),
      message("late", "user", "r", 5),
      message("behind", "user", "r", 2),
    ])
    expect(segments.get("prompt")).toEqual({ runId: "r", from: 0, to: 0 })
    expect(segments.get("old")).toEqual({ runId: "r", from: 0, to: 5 })
    expect(segments.get("late")).toEqual({ runId: "r", from: 5, to: 5 })
    expect(segments.get("behind")).toEqual({ runId: "r", from: 5, to: null })
  })
})

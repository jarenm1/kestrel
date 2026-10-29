import { describe, expect, test } from "bun:test"
import { formatHandoff } from "./handoff"

describe("formatHandoff", () => {
  test("keeps user and agent turns in order, skipping system and empty text", () => {
    const prompt = formatHandoff(
      [
        { role: "system", text: "run started" },
        { role: "user", text: "first question" },
        { role: "agent", text: "   " },
        { role: "agent", text: "first answer" },
        { role: "user", text: "second question" },
      ],
      "new prompt",
    )

    expect(prompt).not.toContain("run started")
    expect(prompt.indexOf("first question")).toBeLessThan(prompt.indexOf("first answer"))
    expect(prompt.indexOf("first answer")).toBeLessThan(prompt.indexOf("second question"))
    expect(prompt.endsWith("new prompt")).toBe(true)
  })

  test("caps the history by dropping the oldest whole messages", () => {
    const prompt = formatHandoff(
      [
        { role: "user", text: "oldest!" },
        { role: "agent", text: "middle" },
        { role: "user", text: "newest" },
      ],
      "new prompt",
      14,
    )

    expect(prompt).not.toContain("oldest!")
    expect(prompt.indexOf("middle")).toBeLessThan(prompt.indexOf("newest"))
  })

  test("attributes another thread's message to that thread's agent, not the user", () => {
    const prompt = formatHandoff(
      [
        { role: "user", text: "typed by the user" },
        { role: "user", text: "sent by a peer", fromThread: { id: "t2", title: "Fix login" } },
      ],
      "new prompt",
    )

    expect(prompt).toContain('User:\ntyped by the user')
    expect(prompt).toContain('Agent of thread "Fix login" (t2):\nsent by a peer')
  })
})

import { describe, expect, test } from "bun:test"
import { DEFAULT_TEXT_GENERATION_SETTINGS } from "@cloudagents/protocol"
import {
  TITLE_MAX,
  cleanGeneratedTitle,
  generationChoice,
  mayReplaceTitle,
  pendingTitleRequest,
  titleSource,
} from "./text-generation"
import { completedProsePrefix, makeTranscript, type Transcript } from "./transcript"

describe("thread title inputs", () => {
  test("an attachment-only message is titled from its file names", () => {
    const source = titleSource("   ", [{ id: "a", mimeType: "image/png", name: "login-error.png" }])
    expect(source).toContain("login-error.png")
    expect(source).not.toContain("undefined")
  })

  test("a long first message is cut to the part that states the request", () => {
    const source = titleSource("x".repeat(10_000), [])
    expect(source.length).toBe(4000)
  })

})

describe("generated title boundaries", () => {
  test("quotes, labels, Markdown and trailing punctuation are removed", () => {
    expect(cleanGeneratedTitle('"Title: Fix the login redirect."')).toBe("Fix the login redirect")
    expect(cleanGeneratedTitle("## Add dark mode toggle")).toBe("Add dark mode toggle")
    expect(cleanGeneratedTitle("```\nFix the flaky test\n```")).toBe("Fix the flaky test")
  })

  test("only the first usable line is kept", () => {
    expect(cleanGeneratedTitle("\n\nFix the flaky test\nbecause it fails")).toBe("Fix the flaky test")
  })

  test("a long answer is bounded", () => {
    const title = cleanGeneratedTitle("word ".repeat(100))
    expect(title).not.toBeNull()
    expect([...(title as string)].length).toBeLessThanOrEqual(TITLE_MAX)
    expect((title as string).endsWith("…")).toBe(true)
  })

  test("an empty answer has no title", () => {
    expect(cleanGeneratedTitle("  \n\n")).toBeNull()
  })
})

describe("generation model choice", () => {
  test("no configured model follows the conversation and keeps a supported level", () => {
    expect(generationChoice(DEFAULT_TEXT_GENERATION_SETTINGS, { model: "gpt-6.1-sol", effort: "high" })).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
    })
  })

  test("an explicit model wins", () => {
    expect(
      generationChoice({ ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "claude-haiku-4-5" }, { model: "gpt-6.1-sol" }),
    ).toEqual({ model: "claude-haiku-4-5" })
  })

  test("a configured level is used when the conversation model supports it", () => {
    expect(
      generationChoice({ ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "deepseek-v4-pro", effort: "max" }, {}),
    ).toEqual({ model: "deepseek-v4-pro", effort: "max" })
  })

  test("no chosen level uses the model's default or lowest supported level, as the composer shows", () => {
    expect(generationChoice({ ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "glm-5.3[1m]" }, {})).toEqual({
      model: "glm-5.3[1m]",
      effort: "max",
    })
    expect(generationChoice({ ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "gpt-6.1-sol" }, {})).toEqual({
      model: "gpt-6.1-sol",
      effort: "low",
    })
    expect(generationChoice(
      { ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "gpt-6.1-sol" },
      { model: "claude-opus-5", effort: "high" },
    )).toEqual({ model: "gpt-6.1-sol", effort: "low" })
  })
})

describe("title request lifecycle", () => {
  const task = { title: "Untitled task", generateTitle: true }

  test("the first user message opts in", () => {
    expect(pendingTitleRequest(task, null, true, "Fix the login redirect", [])).toEqual({
      baseline: "Untitled task",
      source: "Fix the login redirect",
    })
  })

  test("a later message cannot start a second title", () => {
    expect(pendingTitleRequest(task, null, false, "Also do this", [])).toBeNull()
  })

  test("a thread without the opt-in, or another agent's message, is left alone", () => {
    expect(pendingTitleRequest({ title: "Untitled task" }, null, true, "Fix it", [])).toBeNull()
    expect(pendingTitleRequest(task, { id: "parent" }, true, "Assignment", [])).toBeNull()
  })
})

describe("title write race guard", () => {
  const task = { owner: "user", title: "Fix the login redirect" }

  test("a deleted thread takes no generated title", () => {
    expect(mayReplaceTitle(undefined, "user", task.title)).toBe(false)
  })

  test("an archived thread takes no generated title", () => {
    expect(mayReplaceTitle({ ...task, archivedAt: "2026-01-01T00:00:00.000Z" }, "user", task.title)).toBe(false)
  })

  test("a manual rename wins over the generated title", () => {
    expect(mayReplaceTitle({ ...task, title: "Renamed by the user" }, "user", task.title)).toBe(false)
  })

  test("another owner never receives it", () => {
    expect(mayReplaceTitle(task, "someone-else", task.title)).toBe(false)
  })

  test("the untouched provisional title is replaced", () => {
    expect(mayReplaceTitle(task, "user", task.title)).toBe(true)
  })
})

describe("assistant prose boundaries", () => {
  test("a blank line ends a paragraph", () => {
    expect(completedProsePrefix("First paragraph.\n\nSecond")).toBe("First paragraph.\n\n")
    expect(completedProsePrefix("No break yet")).toBe("")
  })

  test("a blank line inside a fence does not publish half a code block", () => {
    expect(completedProsePrefix("Intro.\n\n```ts\nconst a = 1\n\n")).toBe("Intro.\n\n")
    expect(completedProsePrefix("Intro.\n\n```ts\nconst a = 1\n\n```\nAfter")).toBe("Intro.\n\n```ts\nconst a = 1\n\n```\n")
  })

  test("a closing fence without its newline is not complete", () => {
    expect(completedProsePrefix("```\ncode\n```")).toBe("")
  })
})

describe("response streaming modes", () => {
  const start = (transcript: Transcript) => {
    transcript.push({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } }, parent_tool_use_id: null })
    transcript.push({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      parent_tool_use_id: null,
    })
  }
  const delta = (transcript: Transcript, text: string) =>
    transcript.push({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    })
  const result = (transcript: Transcript) =>
    transcript.push({ type: "result", subtype: "success", is_error: false, result: "One.\n\nTwo." })

  test("turn mode reveals prose only when the turn ends", () => {
    const transcript = makeTranscript(null, null, "turn")
    start(transcript)
    expect(delta(transcript, "One.\n\n")).toEqual([])
    expect(delta(transcript, "Two.")).toEqual([])
    const items = transcript.push({ type: "result", subtype: "success", is_error: false, result: "One.\n\nTwo." })
    expect(items.map((item) => item._tag)).toEqual(["text", "turn"])
    expect(items[0]).toMatchObject({ _tag: "text", text: "One.\n\nTwo." })
  })

  test("paragraph mode reveals each finished paragraph, keeping the rest for the turn's end", () => {
    const transcript = makeTranscript(null, null, "paragraph")
    start(transcript)
    const first = delta(transcript, "One.\n\n")
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ _tag: "text", text: "One." })
    expect(delta(transcript, "Two.\n\nThree")).toHaveLength(1)
    const items = result(transcript)
    expect(items.map((item) => item._tag)).toEqual(["text", "turn"])
  })

  test("thinking and tools are not held back", () => {
    const transcript = makeTranscript(null, null, "turn")
    const tool = transcript.push({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      parent_tool_use_id: null,
    })
    expect(tool).toHaveLength(1)
    transcript.push({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_2" } },
      parent_tool_use_id: null,
    })
    transcript.push({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      parent_tool_use_id: null,
    })
    const thinking = transcript.push({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking" } },
      parent_tool_use_id: null,
    })
    expect(thinking).toHaveLength(1)
    expect(
      transcript.push({
        type: "assistant",
        message: { id: "msg_1", content: [{ type: "text", text: "Working" }] },
        parent_tool_use_id: null,
      }),
    ).toEqual([])
  })
})

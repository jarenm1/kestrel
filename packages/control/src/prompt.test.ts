import { describe, expect, test } from "bun:test"
import { composePrompt } from "./prompt"

const base = { name: "Nightly", prompt: "Check the build.", reason: "webhook", repo: null, pr: null }

/** The lines just around the single-line `payload` in `text`: the fence lines that enclose it. */
const fenceAround = (text: string, payload: string): { before: string; after: string } => {
  const lines = text.split("\n")
  const at = lines.indexOf(payload)
  expect(at).toBeGreaterThan(0)
  return { before: lines[at - 1] ?? "", after: lines[at + 1] ?? "" }
}

describe("composePrompt webhook payload", () => {
  test("the raw body reaches the agent verbatim", () => {
    const body = '{"text":"deploy failed","channel":"ops"}'
    expect(composePrompt({ ...base, payload: body })).toContain(body)
  })

  test("a backtick run inside the body cannot close the fence early", () => {
    const body = "before ```` after"
    const { before, after } = fenceAround(composePrompt({ ...base, payload: body }), body)
    expect(before).toMatch(/^`{5,}$/)
    expect(after).toBe(before)
  })
})

import { describe, expect, test } from "bun:test"
import {
  findGithubReferenceTrigger,
  githubReferenceFromLink,
  githubReferenceMarkdown,
  githubReferenceUrl,
  parseGithubReferenceDraft,
  parseGithubReferenceMarkdown,
} from "./githubReference"

describe("findGithubReferenceTrigger", () => {
  test("finds a number after the first word and at the start", () => {
    expect(findGithubReferenceTrigger("Review #123", 11)).toEqual({ start: 7, end: 11, number: 123 })
    // Following text does not stop the menu; choosing keeps it.
    expect(findGithubReferenceTrigger("Review #123 please", 11)).toEqual({ start: 7, end: 11, number: 123 })
    expect(findGithubReferenceTrigger("#12", 3)).toEqual({ start: 0, end: 3, number: 12 })
    expect(findGithubReferenceTrigger("line\n#9", 7)).toEqual({ start: 5, end: 7, number: 9 })
  })

  test("requires a token boundary and a complete positive number", () => {
    expect(findGithubReferenceTrigger("Review#123", 10)).toBeUndefined()
    expect(findGithubReferenceTrigger("word#1", 6)).toBeUndefined()
    expect(findGithubReferenceTrigger("##1", 3)).toBeUndefined()
    expect(findGithubReferenceTrigger("#0", 2)).toBeUndefined()
    expect(findGithubReferenceTrigger("#01", 3)).toBeUndefined()
    expect(findGithubReferenceTrigger("#123abc", 4)).toBeUndefined()
    // The caret is inside a longer number.
    expect(findGithubReferenceTrigger("#1234", 4)).toBeUndefined()
    // Not at the end of the number yet.
    expect(findGithubReferenceTrigger("#123", 3)).toBeUndefined()
    expect(findGithubReferenceTrigger("#", 1)).toBeUndefined()
    expect(findGithubReferenceTrigger("#12 ", 4)).toBeUndefined()
  })

  test("a number followed by punctuation is a reference", () => {
    expect(findGithubReferenceTrigger("See #42, then send", 7)).toEqual({ start: 4, end: 7, number: 42 })
    // The caret before the last digit is inside the number, so the menu is closed there.
    expect(findGithubReferenceTrigger("See #42, then send", 6)).toBeUndefined()
  })
})

describe("reference Markdown", () => {
  const pr = { repo: "acme/kestrel", kind: "pr", number: 123 } as const
  const issue = { repo: "acme/kestrel", kind: "issue", number: 7 } as const

  test("serializes the standard shape", () => {
    expect(githubReferenceMarkdown(pr)).toBe("[PR #123](https://github.com/acme/kestrel/pull/123)")
    expect(githubReferenceMarkdown(issue)).toBe("[Issue #7](https://github.com/acme/kestrel/issues/7)")
    expect(githubReferenceUrl(pr)).toBe("https://github.com/acme/kestrel/pull/123")
  })

  test("round-trips exact tokens only", () => {
    expect(parseGithubReferenceMarkdown(githubReferenceMarkdown(pr))?.reference).toEqual(pr)
    expect(parseGithubReferenceMarkdown(` ${githubReferenceMarkdown(pr)}`)).toBeUndefined()
    expect(parseGithubReferenceMarkdown("[PR #7](https://github.com/acme/kestrel/issues/7)")).toBeUndefined()
    expect(parseGithubReferenceMarkdown("[PR #7](https://example.com/acme/kestrel/pull/7)")).toBeUndefined()
    expect(parseGithubReferenceMarkdown("[PR #7](https://github.com/acme/kestrel/pull/8)")).toBeUndefined()
    expect(parseGithubReferenceMarkdown("[PR #7](https://github.com/acme/kestrel/pull/7)")).toBeDefined()
  })

  test("reads a rendered link by href and exact label", () => {
    expect(githubReferenceFromLink(githubReferenceUrl(pr), "PR #123")).toEqual(pr)
    expect(githubReferenceFromLink(githubReferenceUrl(pr))).toEqual(pr)
    expect(githubReferenceFromLink(githubReferenceUrl(pr), "the pull request")).toBeUndefined()
    expect(githubReferenceFromLink("https://github.com/acme/kestrel/pull/0")).toBeUndefined()
  })
})

describe("parseGithubReferenceDraft", () => {
  test("splits text around multiple chips and keeps the rest verbatim", () => {
    const pr = githubReferenceMarkdown({ repo: "a/b", kind: "pr", number: 1 })
    const issue = githubReferenceMarkdown({ repo: "a/b", kind: "issue", number: 2 })
    const draft = `Review ${pr} and ${issue} now [not a ref](https://example.com)`
    expect(parseGithubReferenceDraft(draft)).toEqual([
      { type: "text", text: "Review " },
      { type: "reference", markdown: pr, reference: { repo: "a/b", kind: "pr", number: 1 } },
      { type: "text", text: " and " },
      { type: "reference", markdown: issue, reference: { repo: "a/b", kind: "issue", number: 2 } },
      { type: "text", text: " now [not a ref](https://example.com)" },
    ])
  })

  test("leaves a mismatched label as ordinary text", () => {
    const draft = "[PR #2](https://github.com/a/b/issues/2)"
    expect(parseGithubReferenceDraft(draft)).toEqual([{ type: "text", text: draft }])
  })
})

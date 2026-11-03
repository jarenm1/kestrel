import { describe, expect, test } from "bun:test"
import { pickedRepoNote, withUserContext } from "./user-context"

describe("pickedRepoNote", () => {
  test("names the repository and how the agent picks what to check out", () => {
    const note = pickedRepoNote("acme/app")
    expect(note).toContain("acme/app")
    expect(note).toContain("repo_checkout")
    expect(note).toContain("`pullRequest`")
    expect(note).toContain("`baseBranch`")
  })

  test("goes in the preamble, before the user's words", () => {
    const prompt = withUserContext("octo", "Fix the build.", [pickedRepoNote("acme/app")])
    expect(prompt.indexOf("acme/app")).toBeLessThan(prompt.indexOf("Fix the build."))
    expect(prompt.endsWith("\n\nFix the build.")).toBe(true)
  })
})

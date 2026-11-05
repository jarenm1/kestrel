import { describe, expect, test } from "bun:test"
import { AGENT_MODELS, modelInfo } from "@cloudagents/protocol"
import {
  filterMentionModels,
  findModelMentionTrigger,
  modelHarnessOf,
  modelMentionMarkdown,
  modelMentionOf,
  parseComposerDraft,
  parseModelMentionMarkdown,
} from "./models"
import { githubReferenceMarkdown, type GithubReference } from "./reference/githubReference"
import { composerViewOf } from "./view"

const reference: GithubReference = { repo: "acme/kestrel", kind: "pr", number: 123 }

describe("modelMentionOf", () => {
  test("names the model, its provider-qualified slug and the harness that runs it", () => {
    expect(modelHarnessOf("anthropic")).toEqual({ harness: "claude", name: "Claude Code" })
    expect(modelHarnessOf("opencode-go")).toEqual({ harness: "opencode", name: "OpenCode" })
    expect(modelHarnessOf("google")).toEqual({ harness: "antigravity", name: "Antigravity" })
    expect(modelMentionOf(modelInfo("claude-opus-5"))).toEqual({
      id: "claude-opus-5",
      provider: "anthropic",
      name: "Claude Opus 5",
      slug: "anthropic/claude-opus-5",
      harness: "claude",
      harnessName: "Claude Code",
    })
    expect(modelMentionOf(modelInfo("gpt-6-astra")).harness).toBe("codex")
    expect(modelMentionOf(modelInfo("gemini-3.8-flash"))).toEqual(expect.objectContaining({
      harness: "antigravity",
      harnessName: "Antigravity",
    }))
  })

  test("keeps an id's own provider prefix instead of repeating it", () => {
    expect(modelMentionOf(modelInfo("opencode/big-pickle")).slug).toBe("opencode/big-pickle")
    expect(modelMentionOf(modelInfo("opencode-go/kimi-k3.1-pro")).slug).toBe("opencode-go/kimi-k3.1-pro")
    // A provider running another provider's models is still qualified by the provider that runs them here.
    expect(modelMentionOf(modelInfo("anthropic/claude-opus-5.5"))).toEqual(expect.objectContaining({
      provider: "openrouter",
      slug: "openrouter/anthropic/claude-opus-5.5",
      harness: "claude",
    }))
  })

  test("every catalog model has one unambiguous, provider-qualified slug", () => {
    const slugs = new Set<string>()
    for (const model of AGENT_MODELS) {
      const mention = modelMentionOf(model)
      expect(mention.slug.startsWith(`${mention.provider}/`)).toBe(true)
      expect(mention.slug.startsWith(`${mention.provider}/${mention.provider}/`)).toBe(false)
      expect(slugs.has(mention.slug)).toBe(false)
      slugs.add(mention.slug)
      expect(parseModelMentionMarkdown(modelMentionMarkdown(model))?.mention).toEqual(mention)
    }
  })
})

describe("findModelMentionTrigger", () => {
  test("finds a token at the start and after whitespace", () => {
    expect(findModelMentionTrigger("@claude-opus-5", 14)).toEqual({ start: 0, end: 14, query: "claude-opus-5" })
    expect(findModelMentionTrigger("Ask @opus", 9)).toEqual({ start: 4, end: 9, query: "opus" })
    expect(findModelMentionTrigger("line\n@codex", 11)).toEqual({ start: 5, end: 11, query: "codex" })
    expect(findModelMentionTrigger("tab\t@zai", 8)).toEqual({ start: 4, end: 8, query: "zai" })
    // A bare `@` opens the whole list.
    expect(findModelMentionTrigger("@", 1)).toEqual({ start: 0, end: 1, query: "" })
  })

  test("replaces the whole token when the caret is inside it", () => {
    expect(findModelMentionTrigger("@claude-opus-5", 7)).toEqual({ start: 0, end: 14, query: "claude-opus-5" })
    expect(findModelMentionTrigger("Pick @glm-5.3[1m] now", 11)).toEqual({ start: 5, end: 17, query: "glm-5.3[1m]" })
    // Query comes from the whole token, not just the part before the caret.
    expect(findModelMentionTrigger("@open/go", 6)).toEqual({ start: 0, end: 8, query: "open/go" })
  })

  test("never treats an email address or a word-embedded @ as a mention", () => {
    expect(findModelMentionTrigger("me@example.com", 14)).toBeUndefined()
    expect(findModelMentionTrigger("me@example.com", 3)).toBeUndefined()
    expect(findModelMentionTrigger("word@x", 6)).toBeUndefined()
    expect(findModelMentionTrigger("@@opus", 6)).toBeUndefined()
    expect(findModelMentionTrigger("(#12)", 5)).toBeUndefined()
  })

  test("does not open away from the token or past its end", () => {
    expect(findModelMentionTrigger("@opus please", 12)).toBeUndefined()
    expect(findModelMentionTrigger("@opus,", 6)).toBeUndefined()
    expect(findModelMentionTrigger("no token here", 7)).toBeUndefined()
    expect(findModelMentionTrigger("@opus", 0)).toBeUndefined()
    expect(findModelMentionTrigger("@opus", 99)).toBeUndefined()
    expect(findModelMentionTrigger("@opus", 2.5)).toBeUndefined()
  })

  test("existing chips are masked, so their labels never reopen a mention menu", () => {
    const model = modelInfo("opencode-go/kimi-k3.1-pro")
    const markdown = `see ${modelMentionMarkdown(model)} and ${githubReferenceMarkdown(reference)}`
    const view = composerViewOf(markdown)
    expect(view.plain).toBe(`see ${model.name} and PR #123`)
    expect(view.referenceText).not.toContain("@")
    expect(findModelMentionTrigger(view.referenceText, view.referenceText.length)).toBeUndefined()
    // Text after a chip still opens one when it starts a word.
    expect(findModelMentionTrigger(`${view.referenceText} @gpt`, view.referenceText.length + 5)).toEqual({
      start: view.referenceText.length + 1,
      end: view.referenceText.length + 5,
      query: "gpt",
    })
  })
})

describe("filterMentionModels", () => {
  const models = [
    modelInfo("claude-opus-5"),
    modelInfo("gpt-6-astra"),
    modelInfo("opencode/big-pickle"),
    modelInfo("gemini-3.8-flash"),
  ]

  test("an empty query keeps the offered models in picker order", () => {
    expect(filterMentionModels(models, "")).toEqual(models)
    expect(filterMentionModels(models, "@")).toEqual(models)
    expect(filterMentionModels(models, "   ")).toEqual(models)
  })

  test("matches names, ids, slugs, providers and harnesses case-insensitively", () => {
    expect(filterMentionModels(models, "OPUS")).toEqual([models[0]!])
    expect(filterMentionModels(models, "big-pickle")).toEqual([models[2]!])
    expect(filterMentionModels(models, "opencode/big")).toEqual([models[2]!])
    expect(filterMentionModels(models, "OPENROUTER")).toEqual([])
    expect(filterMentionModels(models, "codex")).toEqual([models[1]!])
    expect(filterMentionModels(models, "antigravity")).toEqual([models[3]!])
    // Provider display names match too.
    expect(filterMentionModels(models, "anthropic")).toEqual([models[0]!])
  })

  test("every whitespace-separated term must match, and only the given list is offered", () => {
    expect(filterMentionModels(models, "claude opus")).toEqual([models[0]!])
    expect(filterMentionModels(models, "claude codex")).toEqual([])
    expect(filterMentionModels(models, "nothing-like-this")).toEqual([])
    expect(filterMentionModels([models[3]!], "opus")).toEqual([])
  })
})

describe("draft persistence", () => {
  test("a mixed draft parses into text, reference and model segments and serializes back unchanged", () => {
    const model = modelInfo("opencode-go/minimax-m3.1-flash")
    const markdown =
      `Check ${githubReferenceMarkdown(reference)} then mention ` +
      `${modelMentionMarkdown(model)} and keep going.`
    const segments = parseComposerDraft(markdown)

    expect(segments.map((segment) => segment.type)).toEqual(["text", "reference", "text", "model", "text"])
    const referenceSegment = segments[1]!
    const modelSegment = segments[3]!
    expect(referenceSegment.type === "reference" && referenceSegment.reference).toEqual(reference)
    expect(modelSegment.type === "model" && modelSegment.model).toEqual(model)
    expect(modelSegment.type === "model" && modelSegment.mention).toEqual(modelMentionOf(model))
    expect(segments.map((segment) =>
      segment.type === "text" ? segment.text : segment.markdown
    ).join("")).toBe(markdown)
  })

  test("the view masks both chip kinds without losing their visible labels", () => {
    const model = modelInfo("claude-opus-5")
    const markdown = `${githubReferenceMarkdown(reference)} asks ${modelMentionMarkdown(model)}.`
    const view = composerViewOf(markdown)
    const referenceLabel = "PR #123"
    expect(view.plain).toBe(`${referenceLabel} asks ${model.name}.`)
    expect(view.referenceText).toBe(
      `${"\uFFFC".repeat(referenceLabel.length)} asks ${"\uFFFC".repeat(model.name.length)}.`,
    )
    expect(view.referenceText).not.toContain("#123")
    expect(view.referenceText).not.toContain("@")
  })

  test("model links naming an unknown model or mismatched provider/harness stay plain text", () => {
    const model = modelInfo("claude-opus-5")
    const good = modelMentionMarkdown(model)
    const mention = modelMentionOf(model)
    const corrupt = [
      good.replace(mention.id, "not-a-model"),
      good.replace(`provider=${mention.provider}`, "provider=openai"),
      good.replace(`harness=${mention.harness}`, "harness=codex"),
      good.replace(`[@${mention.name}]`, "[@Some Other Name]"),
      `[@${mention.name}](model:${mention.id}?provider=${mention.provider})`,
      `[@${mention.name}](model:${mention.id}?provider=${mention.provider}&harness=claude&extra=1)`,
    ]
    for (const text of corrupt) {
      expect(parseModelMentionMarkdown(text)).toBeUndefined()
      expect(parseComposerDraft(text)).toEqual([{ type: "text", text }])
    }
  })

  test("ids with provider prefixes, dots and brackets round-trip through a draft", () => {
    const ids = ["glm-5.3[1m]", "opencode/big-pickle", "opencode-go/kimi-k3.1-pro", "MiniMax-M3.1-Flash[1m]"] as const
    for (const id of ids) {
      const model = modelInfo(id)
      const token = modelMentionMarkdown(model)
      const parsed = parseModelMentionMarkdown(token)
      expect(parsed?.model.id).toBe(id)
      expect(parsed?.mention.slug).toBe(modelMentionOf(model).slug)
      expect(parseComposerDraft(`a${token}b`)).toEqual([
        { type: "text", text: "a" },
        { type: "model", markdown: token, model, mention: modelMentionOf(model) },
        { type: "text", text: "b" },
      ])
    }
  })
})

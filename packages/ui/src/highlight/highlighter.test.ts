import { describe, expect, test } from "bun:test"
import * as highlights from "@pierre/highlights"
import { tokenize, tokenizeDiff } from "./highlighter"

const text = (lines: readonly (readonly { content: string }[])[]): string =>
  lines.map((line) => line.map((token) => token.content).join("")).join("\n")

describe("syntax tokenization", () => {
  test("nothing is highlighted before the highlighter loads", () => {
    expect(tokenize(null, "const x = 1", { language: "ts" })).toBeNull()
    expect(tokenizeDiff(null, [], { path: "a.ts" })).toBeNull()
  })

  test("tokens keep every character and carry syntax colors", () => {
    const code = 'const answer = 42 // the answer\nfunction greet(name) { return "hi " + name }'
    const tokens = tokenize(highlights, code, { language: "ts" })
    expect(tokens).not.toBeNull()
    expect(text(tokens!)).toBe(code)
    expect(new Set(tokens!.flat().map((token) => token.color)).size).toBeGreaterThan(1)
  })

  test("an unknown language falls back to plain text instead of throwing", () => {
    const code = "not a language\nstill here"
    const tokens = tokenize(highlights, code, { language: "definitely-not-a-language" })
    expect(tokens).not.toBeNull()
    expect(text(tokens!)).toBe(code)
  })

  test("terminal output highlights ANSI colors and drops the escape codes", () => {
    const tokens = tokenize(highlights, "\u001b[31mred\u001b[0m plain", { language: "ansi" })
    expect(tokens).not.toBeNull()
    expect(text(tokens!)).toBe("red plain")
    expect(tokens!.flat().some((token) => token.color !== undefined)).toBe(true)
  })

  test("diff sides map tokens back to each line, using the file's language", () => {
    const lines = [
      { kind: "context" as const, text: 'const greeting = "hi"' },
      { kind: "del" as const, text: "console.log(greeting)" },
      { kind: "add" as const, text: "console.log(greeting, 1)" },
    ]
    const tokens = tokenizeDiff(highlights, [{ lines }], { path: "src/app.ts" })
    expect(tokens).not.toBeNull()
    for (const line of lines) {
      const lineTokens = tokens!.get(line)
      expect(lineTokens).toBeDefined()
      expect(lineTokens!.map((token) => token.content).join("")).toBe(line.text)
      expect(lineTokens!.some((token) => token.color !== undefined)).toBe(true)
    }
  })
})

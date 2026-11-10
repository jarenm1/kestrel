import { describe, expect, test } from "bun:test"
import { getFiletypeFromFileName, languageCandidates } from "./languages"

describe("file language detection", () => {
  test.each([
    ["src/app.ts", "typescript"],
    ["src/App.tsx", "tsx"],
    ["packages/ui/src/cn.ts", "typescript"],
    ["src/main.rs", "rust"],
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
    ["scripts/start.asm", "asm"],
    ["scripts/start.s", "riscv"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["src/CMakeLists.txt", "cmake"],
    ["README.md", "markdown"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language)
  })

  test("unknown and extensionless files are text", () => {
    expect(getFiletypeFromFileName("notes.unknownext")).toBe("text")
    expect(getFiletypeFromFileName("README")).toBe("text")
    expect(getFiletypeFromFileName("src/README")).toBe("text")
  })

  test("a fence hint is tried before the path", () => {
    expect(languageCandidates({ language: "ts", path: "src/app.ts" })).toEqual(["ts", "typescript"])
    expect(languageCandidates({ language: "python", path: "src/app.ts" })).toEqual(["python", "typescript"])
    expect(languageCandidates({ path: "src/app.ts" })).toEqual(["typescript"])
    expect(languageCandidates({})).toEqual([])
  })

  test("a fence's first word is its language", () => {
    expect(languageCandidates({ language: "  TS title=app.ts " })).toEqual(["ts"])
  })
})

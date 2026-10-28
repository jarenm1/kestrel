import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DiffFile, displayPath, parseDiff } from "./diff"

// Same flags as the box (packages/server/src/core/workspace.ts), so these cases are real git output.
const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"]

let dir = ""
const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" })

let files: DiffFile[] = []
const byPath = (path: string): DiffFile => {
  const file = files.find((f) => displayPath(f) === path)
  if (!file) throw new Error(`no section for ${path}: ${files.map(displayPath).join(", ")}`)
  return file
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "diff-test-"))
  git("init", "-q", "-b", "main")
  writeFileSync(join(dir, "lookalike.txt"), "-- not a header\n++ nor this\nkeep\n")
  writeFileSync(join(dir, "with space.txt"), "one\n")
  writeFileSync(join(dir, "old-name.txt"), "a\nb\nc\nd\ne\n")
  writeFileSync(join(dir, "gone.txt"), "bye\n")
  writeFileSync(join(dir, "script.sh"), "echo hi\n")
  writeFileSync(join(dir, "café.txt"), "x\n")
  writeFileSync(join(dir, "tail.txt"), "first\nlast")
  git("add", ".")
  git("commit", "-qm", "base")

  writeFileSync(join(dir, "lookalike.txt"), "keep\n")
  writeFileSync(join(dir, "with space.txt"), "two\n")
  renameSync(join(dir, "old-name.txt"), join(dir, "new-name.txt"))
  rmSync(join(dir, "gone.txt"))
  chmodSync(join(dir, "script.sh"), 0o755)
  writeFileSync(join(dir, "café.txt"), "y\n")
  writeFileSync(join(dir, "tail.txt"), "first\nlast\n")
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]))
  git("add", "-A")
  writeFileSync(join(dir, "untracked.txt"), "fresh\n")
  // --no-index exits 1 when the files differ, so it is not run through `git`.
  const untracked = spawnSync("git", [...DIFF_FLAGS, "--no-index", "--", "/dev/null", "untracked.txt"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout
  files = parseDiff(git(...DIFF_FLAGS, "--find-renames", "HEAD") + untracked)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("parseDiff", () => {
  test("one section per changed file", () => {
    expect(files.map(displayPath).sort()).toEqual(
      ["blob.bin", "café.txt", "gone.txt", "lookalike.txt", "new-name.txt", "script.sh", "tail.txt", "untracked.txt", "with space.txt"].sort(),
    )
  })

  test("removed lines that look like file headers stay content", () => {
    const file = byPath("lookalike.txt")
    expect(file.deletions).toBe(2)
    expect(file.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["del", "-- not a header"],
      ["del", "++ nor this"],
      ["context", "keep"],
    ])
  })

  test("line numbers follow each side", () => {
    const lines = byPath("lookalike.txt").hunks[0]?.lines ?? []
    expect(lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [1, null],
      [2, null],
      [3, 1],
    ])
  })

  test("statuses, renames and mode changes", () => {
    expect(byPath("untracked.txt").status).toBe("added")
    expect(byPath("gone.txt").status).toBe("deleted")
    const renamed = byPath("new-name.txt")
    expect([renamed.status, renamed.oldPath, renamed.hunks.length]).toEqual(["renamed", "old-name.txt", 0])
    const script = byPath("script.sh")
    expect([script.status, script.modeChange]).toEqual(["modified", { from: "100644", to: "100755" }])
    expect(byPath("blob.bin").binary).toBe(true)
  })

  test("paths with spaces and non-ASCII", () => {
    expect(byPath("with space.txt").additions).toBe(1)
    expect(byPath("café.txt").additions).toBe(1)
  })

  test("missing trailing newline marks the line", () => {
    const lines = byPath("tail.txt").hunks[0]?.lines ?? []
    expect(lines.map((l) => [l.kind, l.text, l.noNewline])).toEqual([
      ["context", "first", false],
      ["del", "last", true],
      ["add", "last", false],
    ])
  })
})

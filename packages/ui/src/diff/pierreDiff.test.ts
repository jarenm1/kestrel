import { describe, expect, test } from "bun:test"
import {
  diffFileKey,
  diffFileNotes,
  diffFileStats,
  diffFileStatus,
  displayPath,
  parseDiff,
  patchCacheKey,
} from "./pierreDiff"

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import x",
  "-const version = 1",
  "+const version = 2",
  "+const answer = 42",
  " export default version",
  "diff --git a/added.txt b/added.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/added.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old-name.txt b/new-name.txt",
  "similarity index 100%",
  "rename from old-name.txt",
  "rename to new-name.txt",
  "diff --git a/logo.png b/logo.png",
  "new file mode 100644",
  "index 0000000..1111111",
  "Binary files /dev/null and b/logo.png differ",
  "",
].join("\n")

const parsed = parseDiff(PATCH, "test")
const file = (path: string) => {
  const found = parsed.files.find((candidate) => displayPath(candidate) === path)
  if (found === undefined) throw new Error(`no file ${path}: ${parsed.files.map(displayPath).join(", ")}`)
  return found
}

describe("Pierre diff parsing", () => {
  test("files keep their status, paths and line counts", () => {
    expect(parsed.files).toHaveLength(5)
    expect(parsed.files.map(diffFileStatus)).toEqual(["modified", "added", "deleted", "renamed", "added"])
    expect(displayPath(file("src/app.ts"))).toBe("src/app.ts")
    expect(displayPath(file("gone.txt"))).toBe("gone.txt")
    expect(diffFileKey(file("new-name.txt"))).toBe("old-name.txt\0new-name.txt")
    expect(diffFileStats(file("src/app.ts"))).toEqual({ additions: 2, deletions: 1 })
  })

  test("binary files are marked and get a note instead of a body", () => {
    expect(parsed.binary.has("logo.png")).toBe(true)
    expect(diffFileNotes(file("logo.png"), true)).toContain("Binary file not shown.")
    expect(diffFileNotes(file("new-name.txt"), false)).toEqual(["Renamed without changes."])
  })

  test("a sibling whose path ends in the binary file's name stays empty", () => {
    const sibling = parseDiff(
      [
        "diff --git a/sub/lib.ts b/sub/lib.ts",
        "new file mode 100644",
        "index 0000000..1111111",
        "Binary files /dev/null and b/sub/lib.ts differ",
        "diff --git a/lib.ts b/lib.ts",
        "new file mode 100644",
        "index 0000000..e69de29",
        "",
      ].join("\n"),
      "sibling",
    )
    expect([...sibling.binary]).toEqual(["sub/lib.ts"])
    const empty = sibling.files.find((candidate) => candidate.name === "lib.ts")
    expect(empty).toBeDefined()
    expect(diffFileNotes(empty!, sibling.binary.has("lib.ts"))).toEqual(["Empty file."])
  })

  test("binary detection reads unquoted spaces and quoted escapes in headers", () => {
    const spaced = parseDiff(
      [
        "diff --git a/img file.png b/img file.png",
        "new file mode 100644",
        "index 0000000..1111111",
        "Binary files /dev/null and b/img file.png differ",
        "",
      ].join("\n"),
      "spaces",
    )
    expect(spaced.binary.has("img file.png")).toBe(true)
    const quoted = parseDiff(
      [
        'diff --git "a/caf\\303\\251.png" "b/caf\\303\\251.png"',
        "new file mode 100644",
        "index 0000000..1111111",
        'Binary files /dev/null and "b/caf\\303\\251.png" differ',
        "",
      ].join("\n"),
      "quoted",
    )
    expect(quoted.binary.has("café.png")).toBe(true)
  })

  test("mode changes and empty files keep their notes", () => {
    const mode = parseDiff(
      ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n"),
      "mode",
    ).files[0]!
    expect(diffFileNotes(mode, false)).toEqual(["Mode 100644 → 100755"])
    const empty = parseDiff(
      ["diff --git a/empty.txt b/empty.txt", "new file mode 100644", "index 0000000..e69de29", ""].join("\n"),
      "empty",
    ).files[0]!
    expect(diffFileNotes(empty, false)).toEqual(["Empty file."])
  })

  test("a malformed patch parses to no files instead of throwing", () => {
    expect(parseDiff("not a patch", "bad")).toEqual({ files: [], binary: new Set() })
  })

  test("the cache key changes with the patch and stays stable for the same one", () => {
    expect(patchCacheKey("checkout:c1", PATCH)).toBe(patchCacheKey("checkout:c1", PATCH))
    expect(patchCacheKey("checkout:c1", PATCH)).not.toBe(patchCacheKey("checkout:c1", `${PATCH}\n`))
  })
})

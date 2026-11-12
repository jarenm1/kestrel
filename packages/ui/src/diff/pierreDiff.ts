import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles"
import type { FileDiffMetadata } from "@pierre/diffs/types"

/** Kestrel's four displayed states, derived from Pierre's five change types. */
export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed"

export interface ParsedDiff {
  readonly files: readonly FileDiffMetadata[]
  /** Names of files whose patch only says they are binary; Pierre parses them as empty diffs. */
  readonly binary: ReadonlySet<string>
}

export interface DiffFileStats {
  readonly additions: number
  readonly deletions: number
}

const EMPTY_DIFF: ParsedDiff = { files: [], binary: new Set() }

/** A stable key for one patch's content, so a changed diff never reuses the previous content's cache entries. */
export function patchCacheKey(scope: string, patch: string): string {
  let hash = 2166136261
  for (let index = 0; index < patch.length; index++) {
    hash ^= patch.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${scope}:${patch.length}:${(hash >>> 0).toString(36)}`
}

/** The path shown in a file header: the new path, except for deletions. */
export function displayPath(file: FileDiffMetadata): string {
  return file.type === "deleted" ? (file.prevName ?? file.name) : file.name
}

export function isRenamed(file: FileDiffMetadata): boolean {
  return file.type === "rename-pure" || file.type === "rename-changed"
}

export function diffFileStatus(file: FileDiffMetadata): DiffFileStatus {
  switch (file.type) {
    case "new":
      return "added"
    case "deleted":
      return "deleted"
    case "rename-pure":
    case "rename-changed":
      return "renamed"
    case "change":
      return "modified"
  }
}

/** Identifies a file within one parsed diff; the same path can appear under two repositories. */
export const diffFileKey = (file: FileDiffMetadata): string => `${file.prevName ?? file.name}\0${file.name}`

const statsCache = new WeakMap<FileDiffMetadata, DiffFileStats>()

/** Added and removed line counts, summed over the file's hunks. */
export function diffFileStats(file: FileDiffMetadata): DiffFileStats {
  const cached = statsCache.get(file)
  if (cached !== undefined) return cached
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    additions += hunk.additionLines
    deletions += hunk.deletionLines
  }
  const stats = { additions, deletions }
  statsCache.set(file, stats)
  return stats
}

/** The notes Kestrel shows above a file whose body cannot say it: mode changes, binaries and empty diffs. */
export function diffFileNotes(file: FileDiffMetadata, binary: boolean): string[] {
  const notes: string[] = []
  if (file.prevMode !== undefined && file.mode !== undefined && file.mode !== file.prevMode) {
    notes.push(`Mode ${file.prevMode} → ${file.mode}`)
  }
  if (binary) notes.push("Binary file not shown.")
  else if (file.hunks.length === 0) {
    if (isRenamed(file)) notes.push("Renamed without changes.")
    else if (file.type === "new") notes.push("Empty file.")
    else if (file.type === "deleted") notes.push("Empty file deleted.")
  }
  return notes
}

const GIT_DIFF = "diff --git "
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 }

/** Undoes git's C-style path quoting (`"a/caf\303\251"`); octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let index = 1; index < quoted.length - 1; index++) {
    const char = quoted[index] as string
    if (char !== "\\") {
      bytes.push(...encoder.encode(char))
      continue
    }
    const next = quoted[index + 1] ?? ""
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(quoted.slice(index + 1, index + 4), 8))
      index += 3
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
      index += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The closing quote of a quoted path, skipping escaped characters. */
function closingQuote(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\\") index++
    else if (text[index] === '"') return index
  }
  return -1
}

/** The two paths in a `diff --git` header, decoded and without their `a/`/`b/` prefixes. */
function headerPaths(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice(GIT_DIFF.length)
  if (rest.startsWith('"')) {
    const oldEnd = closingQuote(rest, 1)
    const newStart = oldEnd < 0 ? -1 : rest.indexOf('"', oldEnd + 1)
    const newEnd = newStart < 0 ? -1 : closingQuote(rest, newStart + 1)
    if (oldEnd < 0 || newStart < 0 || newEnd < 0) return null
    return {
      oldPath: unquote(rest.slice(0, oldEnd + 1)).slice(2),
      newPath: unquote(rest.slice(newStart, newEnd + 1)).slice(2),
    }
  }
  // Unquoted headers keep spaces in the path; the ` b/` before the new path is the separator.
  const split = rest.indexOf(" b/", 2)
  if (split < 0) return null
  return { oldPath: rest.slice(2, split), newPath: rest.slice(split + 3) }
}

/**
 * A binary file's patch has no hunks, so Pierre parses it as an empty diff. Find the files whose patch section says
 * `Binary files` or carries a `GIT binary patch`, by comparing the paths in each `diff --git` header.
 */
function binaryFileNames(patch: string, files: readonly FileDiffMetadata[]): ReadonlySet<string> {
  const candidates = files.filter((file) => file.hunks.length === 0)
  const binary = new Set<string>()
  if (candidates.length === 0) return binary
  const lines = patch.split("\n")
  for (const file of candidates) {
    const names = new Set([file.name, ...(file.prevName === undefined ? [] : [file.prevName])])
    let inFile = false
    for (const line of lines) {
      if (line.startsWith(GIT_DIFF)) {
        const paths = headerPaths(line)
        inFile = paths !== null && (names.has(paths.oldPath) || names.has(paths.newPath))
      } else if (inFile && (line.startsWith("Binary files ") || line === "GIT binary patch")) {
        binary.add(file.name)
        break
      }
    }
  }
  return binary
}

/**
 * Parse one checkout or pull-request diff with Pierre's parser. `cacheKeyPrefix` should describe the patch's scope
 * and content, so a new head's diffs do not reuse the previous head's cache entries.
 */
export function parseDiff(patch: string, cacheKeyPrefix: string): ParsedDiff {
  try {
    const files = parsePatchFiles(patch, { cacheKeyPrefix }).flatMap((parsed) => parsed.files)
    return { files, binary: binaryFileNames(patch, files) }
  } catch {
    return EMPTY_DIFF
  }
}

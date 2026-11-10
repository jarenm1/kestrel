import { useSyncExternalStore } from "react"
import type { Highlighter, Lang, ThemedToken, TokensResult } from "@pierre/highlights"
import pierreDark from "@pierre/highlights/themes/pierre-dark"
import { languageCandidates, type LanguageHint } from "./languages"

/**
 * Syntax highlighting for every code surface: the shared transcript (desktop, phone web and the phone's DOM
 * WebView), and the app's diff views.
 *
 * The lexer is `@pierre/highlights`, the WebAssembly highlighter t3code prefers: one 326 KB module with a lexer for
 * every language Shiki bundles, so it loads no grammar per language and tokenizes large diffs quickly. It is imported
 * on first use, not at startup. Until it resolves (or if the runtime has no WebAssembly) code stays plain text.
 */
type Highlights = Pick<Highlighter, "codeToTokens">

/** A line long enough to be a minified file becomes one token, as t3code's mobile highlighter does. */
const MAX_TOKENIZED_LINE = 1000
const CACHE_LIMIT = 100
/** One result larger than this is used once and not retained, so a huge expanded file cannot pin memory. */
const CACHE_MAX_CODE = 200_000
/**
 * Token objects are several times the source's size, so an entry budget alone still retains hundreds of megabytes
 * when large files are opened. Retain at most this much source in total — roughly tens of megabytes of tokens.
 */
const CACHE_MAX_TOTAL_CODE = 500_000

let highlights: Highlights | null = null
let starting = false
let unavailable = false
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): Highlights | null => highlights
const serverSnapshot = (): Highlights | null => null

function start(): void {
  if (highlights !== null || starting || unavailable) return
  starting = true
  void import("@pierre/highlights")
    .then((loaded) => {
      highlights = loaded
      for (const listener of listeners) listener()
    })
    .catch(() => {
      unavailable = true
    })
}

/** The shared highlighter once its module has loaded; null while it is loading and when it is unavailable. */
export function useHighlighter(): Highlights | null {
  start()
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

type TokenLines = readonly (readonly ThemedToken[])[]

interface CachedTokens {
  readonly codeLength: number
  readonly tokens: TokenLines
}

const cache = new Map<string, CachedTokens>()
let cachedCodeLength = 0

function trimCache(): void {
  while (cache.size > CACHE_LIMIT || cachedCodeLength > CACHE_MAX_TOTAL_CODE) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    const entry = cache.get(oldest)
    cache.delete(oldest)
    if (entry !== undefined) cachedCodeLength -= entry.codeLength
  }
}

function tokenizeCached(
  highlighter: Highlights,
  code: string,
  candidates: readonly string[],
): TokenLines | null {
  const key = `${candidates.join("\0")}\0${code}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached.tokens
  let result: TokensResult | undefined
  for (const language of candidates) {
    try {
      result = highlighter.codeToTokens(code, {
        lang: language as Lang,
        theme: pierreDark,
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      })
      break
    } catch {
      // No lexer for this name (or the grammar cannot handle the input): try the next hint.
    }
  }
  if (result === undefined) {
    try {
      result = highlighter.codeToTokens(code, { lang: "text", theme: pierreDark })
    } catch {
      return null
    }
  }
  const tokens = result.tokens
  if (code.length <= CACHE_MAX_CODE) {
    cache.set(key, { codeLength: code.length, tokens })
    cachedCodeLength += code.length
    trimCache()
  }
  return tokens
}

/** Tokens grouped by line; the line count matches `code.split("\n")`. Null while the highlighter is unavailable. */
export function tokenize(
  highlighter: Highlights | null,
  code: string,
  hint: LanguageHint,
): readonly (readonly ThemedToken[])[] | null {
  return highlighter === null ? null : tokenizeCached(highlighter, code, languageCandidates(hint))
}

/** Tokenize the old and new sides of each hunk, so grammar state carries across that hunk's changed lines. */
export function tokenizeDiff<T extends { readonly kind: "context" | "add" | "del"; readonly text: string }>(
  highlighter: Highlights | null,
  hunks: readonly { readonly lines: readonly T[] }[],
  hint: LanguageHint,
): ReadonlyMap<T, readonly ThemedToken[]> | null {
  if (highlighter === null) return null
  const lines = new Map<T, readonly ThemedToken[]>()
  for (const hunk of hunks) {
    for (const side of [
      hunk.lines.filter((line) => line.kind !== "add"),
      hunk.lines.filter((line) => line.kind !== "del"),
    ]) {
      if (side.length === 0) continue
      const tokens = tokenizeCached(highlighter, side.map((line) => line.text).join("\n"), languageCandidates(hint))
      if (tokens === null) continue
      side.forEach((line, index) => lines.set(line, tokens[index] ?? []))
    }
  }
  return lines
}

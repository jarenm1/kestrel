/** A GitHub issue or pull request referenced from a message. */
export type GithubReferenceKind = "pr" | "issue"

export interface GithubReference {
  /** github.com "owner/name". */
  readonly repo: string
  readonly kind: GithubReferenceKind
  readonly number: number
}

/** A `#number` token being typed: `start` is the `#`, `end` the caret. */
export interface GithubReferenceTrigger {
  readonly start: number
  readonly end: number
  readonly number: number
}

/** GitHub owner/repository names, as they appear in a reference URL. */
const REPO = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"

/** One serialized reference: the exact label and the github.com URL it points at. */
const GITHUB_REFERENCE_MARKDOWN = new RegExp(
  `^\\[(PR|Issue) #([1-9]\\d*)\\]\\(https://github\\.com/(${REPO})/(pull|issues)/([1-9]\\d*)\\)$`,
)

/** Any serialized reference inside a longer draft. */
const GITHUB_REFERENCE_IN_DRAFT = new RegExp(
  `\\[(PR|Issue) #([1-9]\\d*)\\]\\(https://github\\.com/(${REPO})/(pull|issues)/([1-9]\\d*)\\)`,
  "g",
)

/** A rendered reference link, by href. */
const GITHUB_REFERENCE_LINK = new RegExp(
  `^https://github\\.com/(${REPO})/(pull|issues)/([1-9]\\d*)$`,
)

/** Characters that keep `#123` glued to a word (`#123abc`), so it is not offered as a reference. */
const WORD = /[\p{L}\p{N}_]/u

const kindOf = (urlPart: string): GithubReferenceKind => (urlPart === "pull" ? "pr" : "issue")

/** The bold-underlined label shown in the editor and rendered from Markdown. */
export function githubReferenceLabel(kind: GithubReferenceKind, number: number): string {
  return `${kind === "pr" ? "PR" : "Issue"} #${number}`
}

/**
 * The `#number` text a chip goes back to when its label is edited: `#` and the digits still in the label. A label that
 * lost its `#` (`PR 181`) keeps its digits; one with no digits left is the `#` the reference was typed from.
 */
export function githubReferenceTypedText(label: string): string {
  const digits = /#(\d*)/.exec(label)?.[1] ?? /\d+/.exec(label)?.[0] ?? ""
  return `#${digits}`
}

/** `https://github.com/owner/repo/pull/123` or `.../issues/123`. */
export function githubReferenceUrl(reference: GithubReference): string {
  return `https://github.com/${reference.repo}/${reference.kind === "pr" ? "pull" : "issues"}/${reference.number}`
}

/** The standard Markdown shape used in drafts and messages. */
export function githubReferenceMarkdown(reference: GithubReference): string {
  return `[${githubReferenceLabel(reference.kind, reference.number)}](${githubReferenceUrl(reference)})`
}

/** True for a positive integer a GitHub reference can carry. */
export function isGithubReferenceNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Reads a reference back from a rendered link's href and label, for Markdown rendering and paste handling.
 * The label must be exactly the one `githubReferenceLabel` produces, so ordinary links to a PR stay ordinary.
 */
export function githubReferenceFromLink(href: string, label?: string): GithubReference | undefined {
  const match = GITHUB_REFERENCE_LINK.exec(href)
  if (match === null) return undefined
  const kind = kindOf(match[2]!)
  const number = Number(match[3])
  if (!isGithubReferenceNumber(number)) return undefined
  if (label !== undefined && label !== githubReferenceLabel(kind, number)) return undefined
  return { repo: match[1]!, kind, number }
}

/** Both halves of one serialized token, or undefined when the text is anything else. */
export function parseGithubReferenceMarkdown(
  text: string,
): { readonly reference: GithubReference; readonly markdown: string } | undefined {
  const match = GITHUB_REFERENCE_MARKDOWN.exec(text)
  if (match === null) return undefined
  const kind = kindOf(match[4]!)
  const number = Number(match[5])
  if (!isGithubReferenceNumber(number) || match[1] !== (kind === "pr" ? "PR" : "Issue") || match[2] !== match[5]) {
    return undefined
  }
  return { reference: { repo: match[3]!, kind, number }, markdown: text }
}

export type GithubDraftSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reference"; readonly markdown: string; readonly reference: GithubReference }

/**
 * Splits stored Markdown into the plain text and reference chips the editor shows. Text that is not one of our
 * exact reference tokens stays text, so drafts written by hand keep their Markdown.
 */
export function parseGithubReferenceDraft(markdown: string): GithubDraftSegment[] {
  const segments: GithubDraftSegment[] = []
  let at = 0
  GITHUB_REFERENCE_IN_DRAFT.lastIndex = 0
  for (let match = GITHUB_REFERENCE_IN_DRAFT.exec(markdown); match !== null; match = GITHUB_REFERENCE_IN_DRAFT.exec(markdown)) {
    const kind = kindOf(match[4]!)
    const number = Number(match[5])
    if (
      !isGithubReferenceNumber(number) ||
      match[1] !== (kind === "pr" ? "PR" : "Issue") ||
      match[2] !== match[5]
    ) {
      continue
    }
    if (match.index > at) segments.push({ type: "text", text: markdown.slice(at, match.index) })
    const token = match[0]
    segments.push({ type: "reference", markdown: token, reference: { repo: match[3]!, kind, number } })
    at = match.index + token.length
  }
  if (at < markdown.length) segments.push({ type: "text", text: markdown.slice(at) })
  return segments
}

/**
 * The `#123` under the caret, when it can become a reference: the `#` starts a token (start or whitespace before it),
 * the number is positive and complete, and neither side is glued to a word. A caret before more digits means the
 * number is still being typed, so no menu shows until it is complete under the caret.
 */
export function findGithubReferenceTrigger(
  text: string,
  caret: number,
): GithubReferenceTrigger | undefined {
  if (!Number.isInteger(caret) || caret < 2 || caret > text.length) return undefined
  let start = caret
  while (start > 0 && text[start - 1]! >= "0" && text[start - 1]! <= "9") start--
  const digits = text.slice(start, caret)
  if (!/^[1-9]\d*$/.test(digits)) return undefined
  // More digits after the caret mean the caret is inside the number, not at its end.
  if (caret < text.length && text[caret]! >= "0" && text[caret]! <= "9") return undefined
  if (start === 0 || text[start - 1] !== "#") return undefined
  const hash = start - 1
  if (hash > 0 && !/\s/.test(text[hash - 1]!)) return undefined
  // `#123abc` is a word, not a reference; trailing punctuation ends the token.
  if (caret < text.length && WORD.test(text[caret]!)) return undefined
  const number = Number(digits)
  return isGithubReferenceNumber(number) ? { start: hash, end: caret, number } : undefined
}

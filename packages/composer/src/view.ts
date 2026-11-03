import { githubReferenceLabel, parseGithubReferenceDraft } from "./reference/githubReference"

/** What the parent needs from the editor after every edit: serialized Markdown, what is visible, and the caret. */
export interface ComposerEditorView {
  /** The draft to store and send; reference chips serialize as Markdown links. */
  readonly markdown: string
  /** What the user sees, including reference labels, in reading order. */
  readonly plain: string
  /** Like `plain`, but reference labels are replaced by one placeholder per character, so `#123` inside a chip is
   * never mistaken for a reference being typed. */
  readonly referenceText: string
  /** Caret position in `plain`/`referenceText` characters. */
  readonly caret: number
}

/** One placeholder per visible chip character. */
export const COMPOSER_CHIP_PLACEHOLDER = "\uFFFC"

/** The draft as the editor shows it, for the parent's first render before the editor reports. */
export function composerViewOf(markdown: string): ComposerEditorView {
  let plain = ""
  let referenceText = ""
  for (const segment of parseGithubReferenceDraft(markdown)) {
    if (segment.type === "text") {
      plain += segment.text
      referenceText += segment.text
    } else {
      const label = githubReferenceLabel(segment.reference.kind, segment.reference.number)
      plain += label
      referenceText += COMPOSER_CHIP_PLACEHOLDER.repeat(label.length)
    }
  }
  return { markdown, plain, referenceText, caret: 0 }
}

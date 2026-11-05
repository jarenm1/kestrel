import { draftTexts } from "./models"

/** What the parent needs from the editor after every edit: serialized Markdown, what is visible, and the caret. */
export interface ComposerEditorView {
  /** The draft to store and send; reference and model-mention chips serialize as Markdown links. */
  readonly markdown: string
  /** What the user sees, including chip labels, in reading order. */
  readonly plain: string
  /** Like `plain`, but chip labels are replaced by one placeholder per character, so text inside a chip (a `#123`
   * reference, a model name) is never mistaken for a token being typed. */
  readonly referenceText: string
  /** Caret position in `plain`/`referenceText` characters. */
  readonly caret: number
}

/** One placeholder per visible chip character. */
export const COMPOSER_CHIP_PLACEHOLDER = "\uFFFC"

/** The draft as the editor shows it, for the parent's first render before the editor reports. */
export function composerViewOf(markdown: string): ComposerEditorView {
  const { plain, referenceText } = draftTexts(markdown, COMPOSER_CHIP_PLACEHOLDER)
  return { markdown, plain, referenceText, caret: 0 }
}

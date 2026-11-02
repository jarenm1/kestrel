import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react"
import {
  githubReferenceLabel,
  githubReferenceMarkdown,
  githubReferenceTypedText,
  parseGithubReferenceDraft,
  parseGithubReferenceMarkdown,
  type GithubReference,
  type GithubReferenceKind,
} from "@/lib/githubReference"
import { cn } from "@/lib/utils"

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

export interface ComposerEditorHandle {
  focus(): void
  /** Focuses and puts the caret at visible character `offset`; used when a menu's picker hands focus back. */
  focusAt(offset: number): void
  /** Replaces visible characters `[start, end)` with plain text, keeping reference chips outside the range. */
  replaceRange(start: number, end: number, replacement: string): void
  /** Replaces visible characters `[start, end)` with a reference chip. */
  insertReference(reference: GithubReference, start: number, end: number): void
}

interface Props {
  /** Serialized Markdown. Edits inside the editor update it through `onChange`. */
  value: string
  placeholder: string
  autoFocus?: boolean
  className?: string
  onChange: (view: ComposerEditorView) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
  onFocus?: () => void
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void
  ariaExpanded: boolean
  ariaControls?: string | undefined
  ariaActiveDescendant?: string | undefined
}

type Mode = "markdown" | "plain" | "reference"

const SVG_NS = "http://www.w3.org/2000/svg"
const PLACEHOLDER = "\uFFFC"

const labelOf = (token: HTMLElement): string => token.dataset.referenceLabel ?? token.textContent ?? ""

/** The token's Markdown is authoritative; its visible label is what the user sees. */
function serializeNode(node: Node, mode: Mode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as HTMLElement
    if (element.dataset?.composerPlaceholder !== undefined) return ""
    const token = element.dataset?.githubReference
    if (token !== undefined) {
      if (mode === "markdown") return token
      const label = labelOf(element)
      return mode === "plain" ? label : PLACEHOLDER.repeat(label.length)
    }
    if (element.tagName === "BR") return "\n"
  }
  let text = ""
  for (const child of node.childNodes) text += serializeNode(child, mode)
  return text
}

function readText(root: HTMLElement, mode: Mode): string {
  // Non-breaking spaces are the browser's way to keep a typed space visible; drafts keep ordinary spaces.
  return serializeNode(root, mode).replace(/\u00A0/g, " ")
}

/** Chromium needs a terminal break to type after a trailing newline; it is not part of the draft. */
function syncTrailingBreak(root: HTMLElement): void {
  const selection = window.getSelection()
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  while (root.lastChild instanceof HTMLBRElement) root.removeChild(root.lastChild)
  // Removing a browser-created empty-line placeholder can otherwise leave the caret out of bounds.
  if (selection !== null && range !== null &&
    (!root.contains(range.endContainer) || (range.endContainer === root && range.endOffset > root.childNodes.length))) {
    setSelection(selection, root, root.childNodes.length)
  }
  if (readText(root, "plain").endsWith("\n")) {
    const placeholder = document.createElement("br")
    placeholder.dataset.composerPlaceholder = "true"
    root.append(placeholder)
  }
}

function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return readText(root, "plain").length
  const range = selection.getRangeAt(0)
  if (!root.contains(range.endContainer)) return readText(root, "plain").length
  const before = document.createRange()
  before.selectNodeContents(root)
  try {
    before.setEnd(range.endContainer, range.endOffset)
  } catch {
    return readText(root, "plain").length
  }
  return serializeNode(before.cloneContents(), "plain").replace(/\u00A0/g, " ").length
}

function setSelection(selection: Selection, node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

interface Leaf {
  readonly node: Node
  readonly start: number
  readonly length: number
  readonly token: boolean
}

function collectLeaves(parent: Node, at: number, leaves: Leaf[]): number {
  for (const child of parent.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = child.textContent?.length ?? 0
      if (length > 0) leaves.push({ node: child, start: at, length, token: false })
      at += length
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as HTMLElement
    if (element.dataset?.composerPlaceholder !== undefined) continue
    if (element.dataset?.githubReference !== undefined) {
      const length = labelOf(element).length
      leaves.push({ node: element, start: at, length, token: true })
      at += length
      continue
    }
    if (element.tagName === "BR") {
      leaves.push({ node: element, start: at, length: 1, token: false })
      at += 1
      continue
    }
    at = collectLeaves(element, at, leaves)
  }
  return at
}

function childIndex(node: Node): number {
  return node.parentNode === null ? 0 : Array.prototype.indexOf.call(node.parentNode.childNodes, node)
}

/** Native redo can restore its caret inside a non-editable chip; typing must resume after the chip. */
function normalizeChipCaret(root: HTMLElement): void {
  const selection = window.getSelection()
  if (selection === null || !selection.isCollapsed || selection.anchorNode === null) return
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement
  const token = anchor?.closest("[data-github-reference]")
  if (token !== null && token !== undefined && token.parentNode !== null && root.contains(token)) {
    setSelection(selection, token.parentNode, childIndex(token) + 1)
  }
}

/** Where visible offset `at` sits in the DOM. Text maps into its node; chips and breaks map to their edges. */
function pointAt(root: HTMLElement, at: number, end: boolean): { node: Node; offset: number } {
  const leaves: Leaf[] = []
  collectLeaves(root, 0, leaves)
  for (const leaf of leaves) {
    const leafEnd = leaf.start + leaf.length
    if (at < leaf.start) break
    if (!leaf.token && leaf.node.nodeType === Node.TEXT_NODE) {
      if (at <= leafEnd) return { node: leaf.node, offset: at - leaf.start }
      continue
    }
    if (at === leaf.start) {
      return { node: leaf.node.parentNode ?? root, offset: childIndex(leaf.node) }
    }
    if (at <= leafEnd) {
      return { node: leaf.node.parentNode ?? root, offset: childIndex(leaf.node) + 1 }
    }
  }
  return { node: root, offset: end ? root.childNodes.length : 0 }
}

function rangeForVisible(root: HTMLElement, start: number, end: number): Range {
  const range = document.createRange()
  const from = pointAt(root, Math.max(0, Math.min(start, end)), false)
  const to = pointAt(root, Math.max(0, Math.max(start, end)), true)
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

function appendIcon(token: HTMLElement, kind: GithubReferenceKind): void {
  const svg = document.createElementNS(SVG_NS, "svg")
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "relative top-0.5 size-3.5 shrink-0 self-center",
  })) {
    svg.setAttribute(name, value)
  }
  const shape = (tag: "circle" | "path" | "line", attributes: Record<string, string>) => {
    const element = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
    svg.append(element)
  }
  if (kind === "pr") {
    shape("circle", { cx: "18", cy: "18", r: "3" })
    shape("circle", { cx: "6", cy: "6", r: "3" })
    shape("path", { d: "M13 6h3a2 2 0 0 1 2 2v7" })
    shape("line", { x1: "6", x2: "6", y1: "9", y2: "21" })
  } else {
    shape("circle", { cx: "12", cy: "12", r: "1" })
    shape("circle", { cx: "12", cy: "12", r: "10" })
  }
  token.append(svg)
}

const CHIP_CLASS =
  "mx-px inline-flex items-baseline gap-1 whitespace-nowrap font-semibold underline underline-offset-4 text-foreground"

/** A reference chip: an atomic, non-editable inline token with the same bold, underlined look as sent Markdown. */
function createReferenceToken(reference: GithubReference): HTMLSpanElement {
  const token = document.createElement("span")
  token.dataset.githubReference = githubReferenceMarkdown(reference)
  token.dataset.referenceLabel = githubReferenceLabel(reference.kind, reference.number)
  token.contentEditable = "false"
  token.className = CHIP_CLASS
  appendIcon(token, reference.kind)
  token.append(document.createTextNode(githubReferenceLabel(reference.kind, reference.number)))
  return token
}

function isIntactChip(token: HTMLElement, label: string): boolean {
  return (
    token.contentEditable === "false" &&
    token.className === CHIP_CLASS &&
    token.childNodes.length === 2 &&
    token.firstChild instanceof SVGElement &&
    token.lastChild?.nodeType === Node.TEXT_NODE &&
    token.lastChild.textContent === label
  )
}

function isFlat(root: HTMLElement): boolean {
  for (const child of root.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as HTMLElement
    if (element.tagName === "BR") continue
    const markdown = element.dataset.githubReference
    const parsed = markdown === undefined ? undefined : parseGithubReferenceMarkdown(markdown)
    if (parsed === undefined) return false
    if (!isIntactChip(element, githubReferenceLabel(parsed.reference.kind, parsed.reference.number))) return false
  }
  return true
}

/**
 * The draft is flat: text, breaks and intact chips directly under the root. WebKit (Safari, iOS) breaks that while
 * typing: it wraps text typed beside a chip in elements copying the chip's bold/underline, can type into the chip, and
 * can delete characters out of its label. Wrappers are unwrapped, text typed into a chip moves beside it, and a chip
 * whose label lost characters goes back to the `#number` text it was typed as. The caret stays on the same text.
 */
function flattenDraft(root: HTMLElement): void {
  if (isFlat(root)) return
  const selection = window.getSelection()
  const anchor =
    selection !== null && selection.rangeCount > 0 && selection.anchorNode !== null
      ? { node: selection.anchorNode, offset: selection.anchorOffset }
      : null
  const fallback = caretOffset(root)
  let caret: { node: Node; offset: number } | null = anchor?.node.nodeType === Node.TEXT_NODE ? anchor : null
  const caretIn = (element: Element) => anchor !== null && element.contains(anchor.node)

  const flatten = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as HTMLElement
      if (element.tagName === "BR") continue
      const markdown = element.dataset.githubReference
      const parsed = markdown === undefined ? undefined : parseGithubReferenceMarkdown(markdown)
      if (parsed !== undefined) {
        const label = githubReferenceLabel(parsed.reference.kind, parsed.reference.number)
        if (isIntactChip(element, label)) continue
        const text = element.textContent ?? ""
        const at = text.indexOf(label)
        const replacement: Node[] = []
        if (at === -1) {
          replacement.push(document.createTextNode(githubReferenceTypedText(text)))
        } else {
          if (at > 0) replacement.push(document.createTextNode(text.slice(0, at)))
          replacement.push(createReferenceToken(parsed.reference))
          if (at + label.length < text.length) replacement.push(document.createTextNode(text.slice(at + label.length)))
        }
        const last = replacement[replacement.length - 1]!
        element.replaceWith(...replacement)
        // A caret that was in the chip continues after whatever replaced it.
        if (caretIn(element)) {
          caret = last.nodeType === Node.TEXT_NODE
            ? { node: last, offset: last.textContent?.length ?? 0 }
            : { node: last.parentNode ?? root, offset: childIndex(last) + 1 }
        }
        continue
      }
      // A block WebKit started for a new line keeps that line break.
      if ((element.tagName === "DIV" || element.tagName === "P") && element.previousSibling !== null) {
        element.before(document.createTextNode("\n"))
      }
      flatten(element)
      element.replaceWith(...element.childNodes)
    }
  }
  flatten(root)

  if (selection === null) return
  if (caret !== null && root.contains(caret.node)) {
    setSelection(selection, caret.node, caret.offset)
  } else {
    const point = pointAt(root, fallback, true)
    setSelection(selection, point.node, point.offset)
  }
}

function renderDraft(root: HTMLElement, markdown: string): void {
  root.replaceChildren()
  for (const segment of parseGithubReferenceDraft(markdown)) {
    if (segment.type === "text") root.append(document.createTextNode(segment.text))
    else root.append(createReferenceToken(segment.reference))
  }
}

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
      referenceText += PLACEHOLDER.repeat(label.length)
    }
  }
  return { markdown, plain, referenceText, caret: 0 }
}

/**
 * The message box's editor. It is a small contentEditable surface rather than a new editor dependency: text stays
 * native (so IME, selection and undo keep working), while chosen `#` references are atomic chips that serialize
 * back to standard Markdown. React never owns the editable children, so typing does not reset the caret.
 */
export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(
  {
    value,
    placeholder,
    autoFocus,
    className,
    onChange,
    onKeyDown,
    onPaste,
    onFocus,
    onBlur,
    ariaExpanded,
    ariaControls,
    ariaActiveDescendant,
  },
  ref,
) {
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const initialized = useRef(false)
  // The last Markdown this editor produced. A `value` change from anywhere else is a draft/send write to render.
  const lastSerialized = useRef<string | null>(null)
  const [empty, setEmpty] = useState(() => composerViewOf(value).plain === "")
  const [composingText, setComposingText] = useState(false)
  const callbacks = useRef({ onChange, onKeyDown, onPaste })
  callbacks.current = { onChange, onKeyDown, onPaste }

  function readView(): ComposerEditorView {
    const element = root.current
    if (element === null) return composerViewOf(value)
    flattenDraft(element)
    normalizeChipCaret(element)
    syncTrailingBreak(element)
    return {
      markdown: readText(element, "markdown"),
      plain: readText(element, "plain"),
      referenceText: readText(element, "reference"),
      caret: caretOffset(element),
    }
  }

  function notify(): void {
    const view = readView()
    lastSerialized.current = view.markdown
    setEmpty(view.plain === "")
    callbacks.current.onChange(view)
  }

  function insertPlainText(text: string): void {
    const element = root.current
    if (element === null) return
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0 || !element.contains(selection.anchorNode)) {
      element.focus()
      if (selection !== null) setSelection(selection, element, element.childNodes.length)
    }
    const current = window.getSelection()
    if (current === null || current.rangeCount === 0) return
    const range = current.getRangeAt(0)
    const before = document.createRange()
    before.selectNodeContents(element)
    before.setEnd(range.startContainer, range.startOffset)
    const start = serializeNode(before.cloneContents(), "plain").length
    const normalized = text.replace(/\r\n?/g, "\n")
    const escaped = document.createElement("span")
    escaped.textContent = normalized
    // Native editing commands preserve the browser's undo history; Range mutations do not.
    if (text === "") document.execCommand("delete")
    else document.execCommand("insertHTML", false, escaped.innerHTML)
    syncTrailingBreak(element)
    const point = pointAt(element, start + normalized.length, true)
    setSelection(current, point.node, point.offset)
    notify()
  }

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        root.current?.focus()
      },
      focusAt(offset) {
        const element = root.current
        if (element === null) return
        element.focus()
        const selection = window.getSelection()
        if (selection !== null) {
          const point = pointAt(element, offset, true)
          setSelection(selection, point.node, point.offset)
        }
        notify()
      },
      replaceRange(start, end, replacement) {
        const element = root.current
        if (element === null) return
        const range = rangeForVisible(element, start, end)
        const selection = window.getSelection()
        if (selection === null) return
        element.focus()
        selection.removeAllRanges()
        selection.addRange(range)
        insertPlainText(replacement)
      },
      insertReference(reference, start, end) {
        const element = root.current
        if (element === null) return
        // At the end of a line the chip gets a following space, so the caret sits in plain text: words typed next
        // neither join the chip's label nor pick up its bold/underline (WebKit copies the style of the text before).
        const next = readText(element, "plain").charAt(Math.max(start, end))
        const spaced = next === "" || next === "\n"
        const range = rangeForVisible(element, start, end)
        const selection = window.getSelection()
        if (selection === null) return
        element.focus()
        selection.removeAllRanges()
        selection.addRange(range)
        const token = createReferenceToken(reference)
        document.execCommand("insertHTML", false, token.outerHTML + (spaced ? "\u00A0" : ""))
        flattenDraft(element)
        const point = pointAt(element, Math.min(start, end) + labelOf(token).length + (spaced ? 1 : 0), true)
        setSelection(selection, point.node, point.offset)
        notify()
      },
    }),
    [],
  )

  useLayoutEffect(() => {
    const element = root.current
    if (element === null) return
    // Drafts and programmatic writes replace the children; edits from the user already match and keep their caret.
    if (!initialized.current || value !== lastSerialized.current) {
      renderDraft(element, value)
      if (autoFocus || document.activeElement === element) {
        const selection = window.getSelection()
        if (selection !== null) {
          const point = pointAt(element, readText(element, "plain").length, true)
          setSelection(selection, point.node, point.offset)
        }
      }
      notify()
    }
    initialized.current = true
  }, [value])

  useEffect(() => {
    if (autoFocus) root.current?.focus()
  }, [autoFocus])

  // Arrow keys and clicks move the caret without an input event; the slash and reference menus follow the caret too.
  useEffect(() => {
    const onSelectionChange = () => {
      if (composing.current) return
      const element = root.current
      const selection = window.getSelection()
      if (
        element === null ||
        document.activeElement !== element ||
        selection === null ||
        selection.rangeCount === 0 ||
        !element.contains(selection.anchorNode)
      ) {
        return
      }
      notify()
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [])

  // Backspace into a chip turns it back into the `#number` it was typed as, minus its last digit: deleting the number
  // edits the reference instead of removing it whole, and the menu reopens for what is left.
  useEffect(() => {
    const element = root.current
    if (element === null) return
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward" || event.isComposing || composing.current) return
      const selection = window.getSelection()
      if (selection === null || !selection.isCollapsed || !element.contains(selection.anchorNode)) return
      normalizeChipCaret(element)
      const caret = caretOffset(element)
      const leaves: Leaf[] = []
      collectLeaves(element, 0, leaves)
      const chip = leaves.find((leaf) => leaf.token && leaf.start + leaf.length === caret)
      if (chip === undefined) return
      event.preventDefault()
      const typed = githubReferenceTypedText(labelOf(chip.node as HTMLElement))
      const text = typed.length > 1 ? typed.slice(0, -1) : typed
      selection.removeAllRanges()
      selection.addRange(rangeForVisible(element, chip.start, caret))
      // A native command keeps undo; the flattening in `notify` removes any style WebKit carries over from the chip.
      document.execCommand("insertText", false, text)
      flattenDraft(element)
      const point = pointAt(element, chip.start + text.length, true)
      setSelection(selection, point.node, point.offset)
      notify()
    }
    element.addEventListener("beforeinput", onBeforeInput)
    return () => element.removeEventListener("beforeinput", onBeforeInput)
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!event.nativeEvent.isComposing && root.current !== null) normalizeChipCaret(root.current)
    callbacks.current.onKeyDown?.(event)
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return
    // Enter sends or picks from a menu (the composer handles those). Shift+Enter is the one newline key.
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault()
      insertPlainText("\n")
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>): void {
    callbacks.current.onPaste?.(event)
    if (event.defaultPrevented) return
    // Never let the browser insert clipboard HTML (styles, images, layout) into the editable surface.
    event.preventDefault()
    const text = event.clipboardData.getData("text/plain")
    if (text !== "") insertPlainText(text)
  }

  return (
    <div className="relative w-full">
      <div
        ref={root}
        role="combobox"
        aria-label="Message"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-activedescendant={ariaActiveDescendant}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        tabIndex={0}
        className={cn(
          "min-h-12 w-full overflow-y-auto rounded-xl bg-input px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words shadow-well transition-[background-color,box-shadow] duration-200 ease-out outline-none",
          "focus-visible:bg-white/[0.07] focus-visible:shadow-glow",
          className,
        )}
        onInput={() => {
          if (!composing.current) notify()
        }}
        onCompositionStart={() => {
          composing.current = true
          setComposingText(true)
        }}
        onCompositionEnd={() => {
          composing.current = false
          setComposingText(false)
          notify()
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {empty && !composingText && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 px-3.5 py-2.5 text-sm text-muted-foreground/70"
        >
          {placeholder}
        </div>
      )}
    </div>
  )
})

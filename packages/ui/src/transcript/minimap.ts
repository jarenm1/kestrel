import type { Message } from "@cloudagents/protocol"

/** Layout and item derivation for the transcript minimap, ported from t3code's `TimelineMinimap`. */

const ITEM_SPACING = 8
export const MINIMAP_MIN_ITEMS = 2
const MAX_HEIGHT_CSS = "calc(100vh - 18rem)"
const PERSISTENT_GUTTER = 48
const HIT_STRIP_LEFT = 12
const HIT_STRIP_MAX_WIDTH = 40
const EXPANDED_HIT_STRIP_WIDTH = "22rem"
const NAVIGATION_REACH = 14

/** One turn: a user message and the last agent reply before the next one. */
export interface MinimapItem {
  readonly id: string
  readonly userText: string
  readonly assistantText: string | null
}

export function deriveMinimapItems(sortedMessages: readonly Message[]): MinimapItem[] {
  const items: MinimapItem[] = []
  let current: { id: string; userText: string; assistantText: string | null } | undefined
  for (const message of sortedMessages) {
    if (message.role === "user") {
      if (current) items.push(current)
      current = { id: message.id, userText: message.text, assistantText: null }
    } else if (message.role === "agent" && current) {
      current.assistantText = message.text
    }
  }
  if (current) items.push(current)
  return items
}

function compactPreview(text: string | null): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? ""
  return compact.length > 0 ? compact : null
}

/** Markdown reduced to its words for a three-line preview; bounded so long replies stay cheap. */
function markdownToPlainText(markdown: string): string {
  return markdown
    .slice(0, 1_500)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|\*|_|`)/g, "")
}

export function resolveMinimapPreview(item: MinimapItem | null) {
  if (item === null) return null
  return {
    userText: compactPreview(item.userText),
    assistantText: compactPreview(item.assistantText === null ? null : markdownToPlainText(item.assistantText)),
  }
}

export function resolveMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * ITEM_SPACING)
  return `min(${naturalHeight}px, ${MAX_HEIGHT_CSS})`
}

export function resolveMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
}

export function resolveMinimapIndexFromPointer(input: {
  readonly itemCount: number
  readonly railTop: number
  readonly railHeight: number
  readonly pointerY: number
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null
  if (input.itemCount === 1) return 0
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight))
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))))
}

/**
 * The turn being read: the first user message in view, otherwise the one whose reply fills the view.
 * `visible[i]` says whether item i's message is in view; `above[i]` whether it sits above the view.
 */
export function resolveMinimapCurrentIndex(visible: readonly boolean[], above: readonly boolean[]): number | null {
  let preceding: number | null = null
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index]) return index
    if (above[index]) preceding = index
    else break
  }
  return preceding
}

function sideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) return 0
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2)
}

export function resolveMinimapHasPersistentGutter(viewportWidth: number, contentWidth: number): boolean {
  return sideGutter(viewportWidth, contentWidth) >= PERSISTENT_GUTTER
}

export function resolveMinimapHitStripWidth(viewportWidth: number, contentWidth: number): number {
  return Math.max(0, Math.min(HIT_STRIP_MAX_WIDTH, Math.floor(sideGutter(viewportWidth, contentWidth)) - HIT_STRIP_LEFT))
}

export function resolveMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= NAVIGATION_REACH
}

export function resolveMinimapInteractiveWidth(collapsedWidth: number, expanded: boolean): number | string {
  return expanded ? EXPANDED_HIT_STRIP_WIDTH : collapsedWidth
}

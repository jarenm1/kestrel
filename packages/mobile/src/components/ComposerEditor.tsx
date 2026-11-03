"use dom"

import { useRef, type Ref } from "react"
import { IS_DOM, useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from "expo/dom"
import {
  ComposerEditor as SharedComposerEditor,
  composerViewOf,
  type ComposerEditorHandle,
  type ComposerEditorView,
} from "@cloudagents/composer/editor"
import type { GithubReference } from "@cloudagents/composer/reference"
import { composerEditorStyles } from "./composerEditorStyles"
import { domHostReset } from "./domHostReset"

/**
 * The native side's handle. Expo's DOM ref bridge forwards arguments as JSON and discards return values, so every
 * method must be fire-and-forget; `requestSubmit` reports the freshest view through the `onSubmit` action instead of
 * returning it. Expo's factory index signature accepts arbitrary JSON arguments; the public methods below retain
 * their narrower, typed call signatures. Only the bridge's factory result needs the intersection cast.
 */
export interface ComposerEditorDomRef {
  focus(): void
  focusAt(offset: number): void
  replaceRange(start: number, end: number, replacement: string): void
  insertReference(reference: GithubReference, start: number, end: number): void
  /** Flushes the live editor content to the `onSubmit` native action; the native ref bridge cannot return it. */
  requestSubmit(): void
  /** Empties the draft after a successful send without moving focus. */
  clear(): void
}

/** Native-facing handle name used by the phone composer. */
export type DOMRef = ComposerEditorDomRef & DOMImperativeFactory

export interface ComposerEditorDomProps {
  ref: Ref<DOMRef>
  /**
   * External-only seed: the persisted Markdown loaded once before mount. Normal edits must NOT be echoed back into
   * this prop over the async bridge (they would arrive late and rewind newer text); persist them from `onChange`,
   * and reset the surface with `clear()` after a send.
   */
  value: string
  placeholder: string
  ariaExpanded: boolean
  /** The native reference/slash menu owns the arrow, Enter, Tab and Escape keys while it is open. */
  menuOpen: boolean
  onChange: (view: ComposerEditorView) => Promise<void>
  /** Receives the live view when `requestSubmit` is called, so Send never reads a stale bridged value. */
  onSubmit: (view: ComposerEditorView) => Promise<void>
  onFocus: () => Promise<void>
  onBlur: () => Promise<void>
  onMenuKey: (key: string) => Promise<void>
  dom?: DOMProps
}

const MENU_KEYS: Readonly<Record<string, true>> = {
  ArrowUp: true,
  ArrowDown: true,
  Enter: true,
  Tab: true,
  Escape: true,
}

/**
 * The phone composer's editing surface: the desktop `ComposerEditor` in a DOM component. It keeps text native for
 * IME/selection/undo, reference chips atomic, and the desktop's WebKit/backspace fixes; only the styling and the
 * Enter-to-newline/async-bridge behavior are mobile-specific.
 */
export default function ComposerEditor({
  ref,
  value,
  placeholder,
  ariaExpanded,
  menuOpen,
  onChange,
  onSubmit,
  onFocus,
  onBlur,
  onMenuKey,
}: ComposerEditorDomProps) {
  const editor = useRef<ComposerEditorHandle>(null)
  const latest = useRef<ComposerEditorView>(composerViewOf(value))
  const menuOpenRef = useRef(menuOpen)
  menuOpenRef.current = menuOpen
  const callbacks = useRef({ onChange, onSubmit })
  callbacks.current = { onChange, onSubmit }

  useDOMImperativeHandle(
    ref,
    () => ({
      focus() {
        editor.current?.focus()
      },
      focusAt(offset) {
        editor.current?.focusAt(Number(offset))
      },
      replaceRange(start, end, replacement) {
        editor.current?.replaceRange(Number(start), Number(end), String(replacement))
      },
      insertReference(reference, start, end) {
        editor.current?.insertReference(reference as GithubReference, Number(start), Number(end))
      },
      requestSubmit() {
        // Read the DOM directly: the last `onChange` may still be on the bridge, and Send must send what is visible.
        const view = editor.current?.readView() ?? latest.current
        void callbacks.current.onSubmit(view)
      },
      clear() {
        editor.current?.clear()
      },
    }) as DOMRef,
    [],
  )

  return (
    <div data-composer-dom-root="">
      <style>{composerEditorStyles + (IS_DOM ? domHostReset : "")}</style>
      <SharedComposerEditor
        ref={editor}
        value={value}
        placeholder={placeholder}
        enterInsertsNewline
        ariaExpanded={ariaExpanded}
        onChange={(view) => {
          latest.current = view
          void callbacks.current.onChange(view)
        }}
        onFocus={() => {
          void onFocus()
        }}
        onBlur={() => {
          void onBlur()
        }}
        onKeyDown={(event) => {
          // Never steal keys from an IME candidate window. Mobile WebViews can also report keyCode 229.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          // Shift+Enter stays a newline and Shift+Tab stays native focus traversal, even with the menu open.
          if (event.shiftKey && (event.key === "Enter" || event.key === "Tab")) return
          if (!menuOpenRef.current || MENU_KEYS[event.key] !== true) return
          // The native menu is the only UI that knows the selection; prevent the DOM from also moving the caret.
          event.preventDefault()
          void onMenuKey(event.key)
        }}
      />
    </div>
  )
}

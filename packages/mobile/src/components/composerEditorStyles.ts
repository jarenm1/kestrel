/**
 * Styles for the shared content-editable composer inside a DOM component. The desktop build styles the editor with
 * Tailwind; a DOM component has no Tailwind runtime, so this mirrors the mobile composer's theme tokens instead.
 * Selectors hang off the stable data attributes the shared editor sets.
 */
export const composerEditorStyles = `
  [data-composer-root] {
    position: relative;
    width: 100%;
  }

  [data-composer-editor] {
    box-sizing: border-box;
    width: 100%;
    min-height: 48px;
    max-height: 160px;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    margin: 0;
    padding: 6px;
    border: 0;
    border-radius: 14px;
    background: transparent;
    box-shadow: none;
    color: #ededef;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    outline: none;
    caret-color: #ededef;
    -webkit-user-select: text;
    user-select: text;
  }

  [data-composer-editor]::selection,
  [data-composer-editor] *::selection {
    background: rgba(245, 245, 246, 0.22);
  }

  [data-composer-editor] [data-github-reference] {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    margin: 0 1px;
    white-space: nowrap;
    color: inherit;
    font-weight: 600;
    text-decoration-line: underline;
    text-underline-offset: 4px;
  }

  [data-composer-editor] [data-github-reference] svg {
    position: relative;
    top: 2px;
    flex-shrink: 0;
    align-self: center;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [data-composer-placeholder-layer] {
    position: absolute;
    inset: 0;
    padding: 6px;
    color: rgba(139, 139, 147, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    pointer-events: none;
  }
`

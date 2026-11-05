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

  /* Model mentions use the same compact logo and subtle backing as the shared transcript. */
  [data-composer-editor] [data-model-mention] {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 1px;
    padding: 2px 6px;
    border-radius: 6px;
    background-color: rgba(255, 255, 255, 0.07);
    vertical-align: middle;
    white-space: nowrap;
    color: inherit;
    font-size: 12px;
    font-weight: 500;
  }

  [data-composer-editor] [data-harness-logo] {
    flex-shrink: 0;
    align-self: center;
    width: 12px;
    height: 12px;
  }

  /* A monochrome logo keeps its inline mask style and takes the text color, as on desktop. */
  [data-composer-editor] span[data-harness-logo] {
    background-color: currentColor;
  }

  [data-composer-editor] img[data-harness-logo] {
    object-fit: contain;
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

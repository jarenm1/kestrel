/**
 * For DOM components sized with `matchContents`, and only inside the native WebView (`IS_DOM`): the host document must
 * shrink-wrap its content so the native view can measure it. On phone web the DOM component shares the app document,
 * where these resets would break page layout.
 */
export const domHostReset = `
  html,
  body,
  #root {
    height: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
  }

  html,
  body {
    width: 100%;
    overflow: hidden;
  }

  #root {
    display: block !important;
  }

  body {
    color: #ededef;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
`

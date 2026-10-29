import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Markdown } from "./Markdown"

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe("agent HTML and SVG", () => {
  test("inline SVG and raw HTML blocks render as elements, with markdown inside HTML blocks", () => {
    const html = render(
      `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="steelblue"/></svg>\n\n` +
        `<details><summary>Example</summary>\n\n\`greet("Ada")\` is **ok**.\n\n</details>`,
    )
    expect(html).toContain('<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="steelblue">')
    expect(html).toContain("<details><summary>Example</summary>")
    expect(html).toContain("<code>greet(&quot;Ada&quot;)</code> is <strong>ok</strong>")
  })

  test("nothing that runs code, loads a page or styles the app survives", () => {
    const html = render(
      [
        `<script>alert(1)</script>`,
        `<img src="x" onerror="alert(1)">`,
        `<a href="javascript:alert(1)">x</a>`,
        `<svg onload="alert(1)"><set attributeName="href" to="javascript:alert(1)"/><foreignObject><div>fo</div></foreignObject><use xlink:href="javascript:alert(3)"/></svg>`,
        `<style>body{display:none}</style>`,
        `<div class="fixed inset-0" style="position:fixed">overlay</div>`,
        `<svg style="position:fixed"><rect/></svg>`,
        `<iframe src="https://example.com"></iframe>`,
      ].join("\n\n"),
    )
    for (const banned of ["<script", "alert(", "onerror", "onload", "javascript:", "<set", "<foreignObject", ">fo<", "<style", "display:none", "position:fixed", "inset-0", "<iframe"]) {
      expect(html).not.toContain(banned)
    }
  })

  test("ids are scoped per message and SVG references follow them", () => {
    const svg = `<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect fill="url(#g)" style="opacity:.5"/><use href="#g"/></svg>`
    const html = renderToStaticMarkup(
      <>
        <Markdown text={svg} />
        <Markdown text={svg} />
      </>,
    )
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      expect(html).toContain(`fill="url(#${id})"`)
      expect(html).toContain(`href="#${id}"`)
    }
    // Inside a drawing, inline style stays: it cannot position anything there.
    expect(html).toContain('style="opacity:.5"')
  })
})

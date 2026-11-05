import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Markdown } from "./Markdown"

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe("GitHub references", () => {
  test("typed references retain their destination and distinguish issues from pull requests", () => {
    const html = render(
      "Compare [PR #156](https://github.com/jarenm1/kestrel/pull/156) with " +
        "[Issue #12](https://github.com/jarenm1/kestrel/issues/12).",
    )
    expect(html).toContain('href="https://github.com/jarenm1/kestrel/pull/156"')
    expect(html).toContain('href="https://github.com/jarenm1/kestrel/issues/12"')
    expect(html).toContain("lucide-git-pull-request")
    expect(html).toContain("lucide-circle-dot")
    expect(html).toContain("font-semibold underline")
  })

  test("ordinary links and mismatched labels do not become typed references", () => {
    const html = render(
      "[Issue #156](https://github.com/jarenm1/kestrel/pull/156) " +
        "[PR #156](https://example.com/jarenm1/kestrel/pull/156) " +
        "[documentation](https://github.com/jarenm1/kestrel/issues/12)",
    )
    expect(html).not.toContain("<svg")
    expect(html).not.toContain("font-semibold underline")
    expect(html).toContain(">documentation</a>")
  })
})

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

  test("HTML keeps styles that paint and space it, but nothing that leaves the flow or loads anything", () => {
    const html = render(
      `<div style="background:#0b1020;color:#fff;padding:16px;border-radius:12px;border:2px solid #3355ff;max-width:360px;font-family:Comic Sans MS,cursive">` +
        `<span style="color:#ff3355;position:absolute;top:0">red</span>` +
        `<p style="margin:-40px 0 0;z-index:9;transform:scale(9)">up</p>` +
        `<p style="margin:8px 0 0;background:url(https://attacker.example/a);background-image:linear-gradient(red,blue)">ok</p></div>`,
    )
    expect(html).toContain(
      'style="background:#0b1020;color:#fff;padding:16px;border-radius:12px;border:2px solid #3355ff;max-width:360px;font-family:Comic Sans MS,cursive"',
    )
    expect(html).toContain('<span style="color:#ff3355">red</span>')
    expect(html).toContain("<p>up</p>")
    expect(html).toContain('<p style="margin:8px 0 0">ok</p>')
    for (const banned of ["position", "top:0", "-40px", "z-index", "scale(9)", "attacker.example", "background-image"]) {
      expect(html).not.toContain(banned)
    }
  })

  test("SVG styles and presentation attributes cannot load anything, but painting survives", () => {
    const html = render(
      `<svg viewBox="0 0 10 10"><defs><filter id="f"/></defs>` +
        `<rect style="filter:url(https://attacker.example/x.svg#f);fill:rgb(1,2,3)"/>` +
        `<rect style="fill:u\\rl(https://attacker.example/a)"/>` +
        `<rect style="mask-image:image-set('https://attacker.example/b' 1x)"/>` +
        `<rect style='font-family:"a;fill:url(https://attacker.example/c)"'/>` +
        `<rect fill="url(https://attacker.example/d#g)" stroke="URL( 'https://attacker.example/e' )" filter="url(#f)" transform="rotate(45) translate(1 2)"/>` +
        `<use href="https://attacker.example/f.svg#a"/></svg>`,
    )
    expect(html).not.toContain("attacker.example")
    expect(html).toContain('style="fill:rgb(1,2,3)"')
    expect(html).toMatch(/filter="url\(#md[^"]+-f\)"/)
    expect(html).toContain('transform="rotate(45) translate(1 2)"')
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

  test("a drawing split by blank lines stays one drawing instead of becoming a code sample", () => {
    const html = render(
      `<svg viewBox="0 0 900 120" width="900" height="120" xmlns="http://www.w3.org/2000/svg">\n` +
        `    <rect x="4" y="4" width="150" height="56" rx="8" fill="#1f2937"/>\n` +
        `    <text x="79" y="24" text-anchor="middle" fill="#e5e7eb">turn item stored</text>\n` +
        `\n` +
        `    <rect x="176" y="4" width="150" height="56" rx="8" fill="#14322a"/>\n` +
        `    <text x="251" y="24" text-anchor="middle" fill="#e5e7eb">reset travels with the failure</text>\n` +
        `</svg>`,
    )
    expect(html).toContain('<rect x="4" y="4" width="150" height="56" rx="8" fill="#1f2937">')
    expect(html).toContain('<rect x="176" y="4" width="150" height="56" rx="8" fill="#14322a">')
    expect(html).not.toContain("<pre")
    expect(html).not.toContain("&lt;rect")
  })

  test("a fenced sample of SVG markup keeps its blank lines", () => {
    const html = render("```svg\n<svg>\n  <rect/>\n\n  <rect/>\n</svg>\n```")
    expect(html).toContain("  &lt;rect/&gt;\n\n  &lt;rect/&gt;")
  })

  test("a nested fenced sample keeps its blank lines", () => {
    const html = render("- item\n    ```html\n    <svg>\n\n    <rect/>\n    ```\n")
    expect(html).toContain("&lt;svg&gt;\n\n&lt;rect/&gt;")
  })

  test("an indented code sample of SVG markup keeps its blank lines", () => {
    const html = render('Example:\n\n    <svg viewBox="0 0 10 10">\n\n        <!-- note -->\n        <rect/>\n    </svg>\n')
    expect(html).toContain("&lt;svg viewBox=&quot;0 0 10 10&quot;&gt;\n\n    &lt;!-- note --&gt;")
  })

  test("a stray `<svg>` in prose does not reach into the paragraphs and code after it", () => {
    const html = render("<svg> starts a drawing in prose.\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nClose with </svg> later.")
    expect(html).toContain("const a = 1\n\nconst b = 2")
    expect(html.match(/<p>/g)).toHaveLength(2)
  })

  test("a bare `<svg>` line leaves the list and paragraphs after it alone", () => {
    const html = render("Use <svg> to start.\n<svg>\n\n- one\n\n    - nested\n\n- two\n\nLater says </svg> done.")
    expect(html).toContain("<p>one</p>")
    expect(html).toContain("<li>nested</li>")
    expect(html).toContain("<p>two</p>")
  })

  test("a drawing whose elements are indented one to three spaces is still kept whole", () => {
    const html = render('<svg viewBox="0 0 10 10">\n  <rect width="4"/>\n\n  <text x="1" y="1">hi</text>\n</svg>')
    expect(html).toContain('<rect width="4">')
    expect(html).toContain('<text x="1" y="1">hi</text>')
    expect(html).not.toContain("&lt;rect")
  })

  test("a drawing indented under a list item is still kept whole", () => {
    const html = render(
      '- item\n\n    <svg viewBox="0 0 10 10">\n        <rect width="4" height="4"/>\n\n        <text x="1" y="1">hi</text>\n    </svg>\n',
    )
    expect(html).toContain('<rect width="4" height="4">')
    expect(html).toContain('<text x="1" y="1">hi</text>')
    expect(html).not.toContain("&lt;rect")
  })

  test("text inside a drawing keeps its character references as text", () => {
    const html = render('<svg viewBox="0 0 10 10">\n\n <text x="1" y="1">a &lt;rect/&gt; b</text>\n</svg>')
    expect(html).toContain('<text x="1" y="1">a &lt;rect/&gt; b</text>')
    expect(html).not.toContain("<rect")
  })

  test("a fenced sample without a language stays a code sample", () => {
    const html = render('<svg viewBox="0 0 10 10">\n\n```\n<rect/>\n</svg>\n```\n')
    expect(html).toContain("<pre><code>")
    expect(html).toContain("&lt;rect/&gt;")
  })
})

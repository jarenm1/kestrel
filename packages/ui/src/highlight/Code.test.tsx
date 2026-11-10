import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TokenLine, TokenizedText } from "./Code"

describe("code token rendering", () => {
  test("tokens render as styled spans with the source text", () => {
    const html = renderToStaticMarkup(
      <TokenLine
        tokens={[
          { content: "const ", offset: 0, color: "#ff678d" },
          { content: "answer", offset: 6, color: "#ffa359", fontStyle: 3 },
        ]}
        fallback="const answer"
      />,
    )
    expect(html).toContain('<span style="color:#ff678d">const </span>')
    expect(html).toContain('<span style="color:#ffa359;font-style:italic;font-weight:700">answer</span>')
  })

  test("plain text is shown until the highlighter has tokens", () => {
    expect(renderToStaticMarkup(<TokenLine tokens={undefined} fallback="$ npm test" />)).toBe("$ npm test")
    expect(renderToStaticMarkup(<TokenizedText code={"a\nb"} language="lua" />)).toBe("a\nb")
  })
})

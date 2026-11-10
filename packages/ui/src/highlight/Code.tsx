import { Fragment, useMemo, type CSSProperties } from "react"
import type { ThemedToken } from "@pierre/highlights"
import { useHighlighter, tokenize } from "./highlighter"

function tokenStyle(token: ThemedToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0
  const decoration = [fontStyle & 4 ? "underline" : "", fontStyle & 8 ? "line-through" : ""].filter(Boolean).join(" ")
  return {
    ...(token.color === undefined ? {} : { color: token.color }),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(decoration === "" ? {} : { textDecoration: decoration }),
  }
}

/** One highlighted line, or the plain text while the highlighter is loading. */
export function TokenLine({ tokens, fallback }: { tokens: readonly ThemedToken[] | undefined; fallback: string }) {
  if (tokens === undefined) return <>{fallback}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  )
}

/** Highlighted code as inline text, keeping one rendered line per source line. */
export function TokenizedText({ code, language, path }: { code: string; language?: string | null; path?: string }) {
  const highlighter = useHighlighter()
  const tokens = useMemo(() => tokenize(highlighter, code, { language, path }), [highlighter, code, language, path])
  if (tokens === null || tokens.length === 0) return <>{code}</>
  return (
    <>
      {tokens.map((line, index) => (
        <Fragment key={index}>
          {index === 0 ? null : "\n"}
          <TokenLine tokens={line} fallback="" />
        </Fragment>
      ))}
    </>
  )
}

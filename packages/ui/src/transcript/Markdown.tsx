import { useId, useMemo, type ComponentProps } from "react"
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { CircleDot, GitPullRequest } from "lucide-react"
import { githubReferenceFromLink } from "@cloudagents/composer/reference"
import { cn } from "../cn"
import { AGENT_HTML_SCHEMA, rehypeAgentSvg } from "./agentHtml"
import { externalClick, useTranscriptHost } from "./host"

function Link({ node: _node, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const host = useTranscriptHost()
  const reference = typeof children === "string" ? githubReferenceFromLink(props.href ?? "", children) : undefined
  const isReference = reference !== undefined
  const Icon = reference?.kind === "pr" ? GitPullRequest : CircleDot
  return (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      onClick={externalClick(host, props.href)}
      className={isReference ? "inline-flex items-baseline gap-1 font-semibold underline underline-offset-4" : undefined}
    >
      {isReference && <Icon aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0 self-center" />}
      {children}
    </a>
  )
}

const COMPONENTS: Components = { a: Link }

// Single newlines stay line breaks: run output that falls back to raw stdout/stderr is line-oriented.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/** A code fence opener: up to three spaces of indent, then a run of backticks or tildes. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
/** A code fence closer: its run alone on the line, at least as long as the opener's. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** A line that begins a drawing: an `<svg>` tag, indented or not, at the start of the line. */
const DRAWING_OPEN = /^\s*<svg\b/i
const DRAWING_CLOSE = /<\/svg\s*>/i

/**
 * Markdown ends a raw HTML block at a blank line, so a drawing whose elements are indented in blank-line-separated
 * groups falls apart: the first group renders, and the rest arrives as an indented code sample. Blank lines inside a
 * drawing are dropped to keep it in one block; fenced code samples keep theirs.
 */
function keepDrawingsWhole(text: string): string {
  if (!DRAWING_CLOSE.test(text)) return text
  const lines: string[] = []
  let fence: string | undefined
  let drawing = false
  for (const line of text.split("\n")) {
    if (drawing) {
      if (line.trim().length > 0) lines.push(line)
      if (DRAWING_CLOSE.test(line)) drawing = false
      continue
    }
    const opener = FENCE_OPEN.exec(line)?.[1]
    const closer = FENCE_CLOSE.exec(line)?.[1]
    if (fence !== undefined) {
      lines.push(line)
      if (closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length) fence = undefined
      continue
    }
    if (opener !== undefined) {
      fence = opener
      lines.push(line)
      continue
    }
    if (DRAWING_OPEN.test(line) && !DRAWING_CLOSE.test(line)) drawing = true
    lines.push(line)
  }
  return lines.join("\n")
}

/**
 * Agent output as GitHub-flavoured markdown. Raw HTML and inline SVG render in place, through the allowlist in
 * `AGENT_HTML_SCHEMA`; ids are prefixed per message so two drawings with the same gradient id don't collide.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "")
  const rehypePlugins = useMemo((): Options["rehypePlugins"] => {
    const prefix = `md${instance}-`
    return [rehypeRaw, [rehypeSanitize, { ...AGENT_HTML_SCHEMA, clobberPrefix: prefix }], rehypeAgentSvg(prefix)]
  }, [instance])
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-invert [--tw-prose-invert-body:var(--color-foreground)] [--tw-prose-invert-bold:var(--color-foreground)] [--tw-prose-invert-headings:var(--color-foreground)]",
        "prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-foreground prose-a:underline-offset-4",
        "prose-code:rounded-md prose-code:bg-white/[0.07] prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-xl prose-pre:bg-code prose-pre:shadow-well prose-pre:[&_code]:bg-transparent prose-pre:[&_code]:p-0",
        "prose-hr:border-border prose-th:text-muted-foreground prose-td:border-border",
        // Drawings scale down to the column, keeping their aspect ratio.
        "[&_svg]:inline-block [&_svg]:h-auto [&_svg]:max-w-full",
        "[&_summary]:cursor-pointer",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={COMPONENTS}>
        {keepDrawingsWhole(text)}
      </ReactMarkdown>
    </div>
  )
}

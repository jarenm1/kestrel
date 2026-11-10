import { useId, useMemo, type ComponentProps } from "react"
import type { Blockquote, List, ListItem, Root, RootContent } from "mdast"
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import CircleDot from "lucide-react/icons/circle-dot"
import GitPullRequest from "lucide-react/icons/git-pull-request"
import { githubReferenceFromLink } from "@cloudagents/composer/reference"
import { cn } from "../cn"
import { TokenizedText } from "../highlight"
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

const COMPONENTS: Components = { a: Link, code: Code }

/** Fenced code is highlighted from its info string; inline code and unlabelled fences stay as they are. */
function Code({ node: _node, className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const language = /^language-(.+)$/.exec(className ?? "")?.[1]
  if (language === undefined) return <code className={className} {...props}>{children}</code>
  const text = (Array.isArray(children) ? children.join("") : String(children ?? "")).replace(/\n$/, "")
  return (
    <code className={className} {...props}>
      <TokenizedText code={text} language={language} />
    </code>
  )
}

// Single newlines stay line breaks: run output that falls back to raw stdout/stderr is line-oriented.
// The drawing repair runs last, so it sees the breaks `remarkBreaks` and the tables `remarkGfm` added.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkDrawingsWhole]

/** A raw HTML block that opens a drawing. */
const DRAWING_OPEN = /^\s*<svg\b[^>]*>/i
const DRAWING_CLOSE = /<\/svg\s*>/i
/** A code fence: a run of backticks or tildes at any indent, the first thing on its line. */
const FENCE = /^\s*(`{3,}|~{3,})/

/** mdast decodes character references in text; put back what raw HTML needs so the drawing keeps its literal text. */
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * The text of a node that continues a drawing interrupted by a blank line: SVG markup as raw HTML, an indented code
 * sample (elements indented four spaces or more), or a paragraph of inline HTML (elements indented one to three).
 * `undefined` for anything else, which ends the search. Fenced code is a sample, not a continuation, so it stays code.
 */
function drawingText(node: RootContent, lines: string[]): string | undefined {
  if (node.type === "html") return node.value
  if (node.type === "code") {
    const line = lines[(node.position?.start.line ?? 0) - 1]
    if (node.lang !== null || line === undefined || FENCE.test(line)) return undefined
    return node.value
  }
  if (node.type !== "paragraph") return undefined
  let text = ""
  for (const child of node.children) {
    if (child.type === "html") text += child.value
    else if (child.type === "text") text += escapeText(child.value)
    else if (child.type === "break") text += "\n"
    else return undefined
  }
  return text
}

/** Containers whose children are blocks: a drawing is only ever one of those, never inline inside a paragraph. */
function isBlockContainer(node: RootContent): node is Blockquote | List | ListItem {
  return node.type === "blockquote" || node.type === "list" || node.type === "listItem"
}

/**
 * Markdown ends a raw HTML block at a blank line, so an inline SVG laid out in blank-line-separated groups falls
 * apart: the block stops at the first blank line and the rest parses as an indented code sample or a paragraph of
 * inline HTML. Merge that continuation back into the raw HTML it belongs to, before the sanitizer sees either, so the
 * whole drawing renders. Prose that merely mentions `<svg>`, and code that quotes SVG markup, are separate nodes and
 * stay as they are.
 */
function remarkDrawingsWhole() {
  return (tree: Root, file?: { value?: unknown }) => {
    const lines = typeof file?.value === "string" ? file.value.split("\n") : []
    const walk = (parent: { children: RootContent[] }) => {
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index]!
        if (node.type === "html" && DRAWING_OPEN.test(node.value) && !DRAWING_CLOSE.test(node.value)) {
          const parts = [node.value]
          let end = index
          let closed = false
          while (end + 1 < parent.children.length) {
            const continuation = drawingText(parent.children[end + 1]!, lines)
            if (continuation === undefined || !continuation.trimStart().startsWith("<")) break
            end += 1
            parts.push(continuation)
            if (DRAWING_CLOSE.test(continuation)) {
              closed = true
              break
            }
          }
          if (closed) {
            node.value = parts.join("\n")
            parent.children.splice(index + 1, end - index)
          }
        }
        const child = parent.children[index]!
        if (isBlockContainer(child)) walk(child)
      }
    }
    walk(tree)
  }
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
        {text}
      </ReactMarkdown>
    </div>
  )
}

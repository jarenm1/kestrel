import { useId, useMemo } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { AGENT_HTML_SCHEMA, rehypeScopeIdRefs } from "@/lib/agentHtml"
import { cn } from "@/lib/utils"

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
}

// Single newlines stay line breaks: run output that falls back to raw stdout/stderr is line-oriented.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/**
 * Agent output as GitHub-flavoured markdown. Raw HTML and inline SVG render in place, through the allowlist in
 * `AGENT_HTML_SCHEMA`; ids are prefixed per message so two drawings with the same gradient id don't collide.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, "")
  const rehypePlugins = useMemo((): Options["rehypePlugins"] => {
    const prefix = `md${instance}-`
    return [rehypeRaw, [rehypeSanitize, { ...AGENT_HTML_SCHEMA, clobberPrefix: prefix }], rehypeScopeIdRefs(prefix)]
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

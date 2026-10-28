import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
}

// Single newlines stay line breaks: run output that falls back to raw stdout/stderr is line-oriented.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/** Agent output as GitHub-flavoured markdown. Raw HTML in the source is not rendered. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words prose-invert [--tw-prose-invert-body:var(--color-foreground)] [--tw-prose-invert-bold:var(--color-foreground)] [--tw-prose-invert-headings:var(--color-foreground)]",
        "prose-headings:font-semibold prose-headings:tracking-tight prose-a:text-foreground prose-a:underline-offset-4",
        "prose-code:rounded-md prose-code:bg-white/[0.07] prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-xl prose-pre:bg-code prose-pre:shadow-well prose-pre:[&_code]:bg-transparent prose-pre:[&_code]:p-0",
        "prose-hr:border-border prose-th:text-muted-foreground prose-td:border-border",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

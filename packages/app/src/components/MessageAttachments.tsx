import { useQuery } from "@tanstack/react-query"
import { Paths, type Attachment } from "@cloudagents/protocol"
import { FileText } from "lucide-react"
import { queries } from "@/api/queries"
import { cn } from "@/lib/utils"

/**
 * A message's files: images inline, other files as a named chip. Either opens the file in a new tab; the box serves
 * attachments with `Content-Security-Policy: sandbox`, so an uploaded HTML file cannot run as the app.
 */
export function MessageAttachments({
  taskId,
  attachments,
  className,
}: {
  taskId: string
  attachments: readonly Attachment[]
  className?: string
}) {
  return (
    <div className={cn("mt-2 flex flex-wrap gap-2", className)}>
      {attachments.map((a) => (
        <AttachmentLink key={a.id} taskId={taskId} attachment={a} />
      ))}
    </div>
  )
}

function AttachmentLink({
  taskId,
  attachment: a,
}: {
  taskId: string
  attachment: Attachment
}) {
  const { data: url } = useQuery(queries.taskFileUrl(taskId, Paths.taskAttachment(taskId, a.id)))
  if (url === undefined) return null
  const label = a.name ?? (a.mimeType.startsWith("image/") ? "Image" : "File")
  return (
    <a href={url} target="_blank" rel="noreferrer" title={label}>
      {a.mimeType.startsWith("image/") ? (
        <img src={url} alt={label} className="max-h-80 rounded-xl shadow-soft" />
      ) : (
        <span className="flex h-11 max-w-64 items-center gap-2 rounded-xl bg-white/[0.06] px-3 text-sm shadow-soft transition-colors hover:bg-white/10">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </span>
      )}
    </a>
  )
}

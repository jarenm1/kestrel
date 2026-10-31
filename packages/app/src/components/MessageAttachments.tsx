import { useQuery } from "@tanstack/react-query"
import type { Attachment } from "@cloudagents/protocol"
import { FileText } from "lucide-react"
import { queries } from "@/api/queries"
import { useActiveBoxId } from "@/hooks/useActiveBox"
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
  const activeBoxId = useActiveBoxId()
  return (
    <div className={cn("mt-2 flex flex-wrap gap-2", className)}>
      {attachments.map((a) => (
        <AttachmentLink key={a.id} taskId={taskId} attachment={a} boxId={activeBoxId} />
      ))}
    </div>
  )
}

function AttachmentLink({
  taskId,
  attachment: a,
  boxId,
}: {
  taskId: string
  attachment: Attachment
  boxId: string | null | undefined
}) {
  const { data: url } = useQuery(queries.attachmentUrl(taskId, a.id, boxId))
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

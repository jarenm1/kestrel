import { join } from "node:path"
import type { Attachment } from "@cloudagents/protocol"

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
}

/** The file name an attachment is written under: the user's name, else its id plus an extension for its type. */
const fileName = (a: Attachment): string => a.name ?? `${a.id}${EXTENSIONS[a.mimeType] ?? ""}`

/** Where an attachment sits under a task home: `<home>/uploads/<id>/<name>`. */
export const attachmentPath = (homeDir: string, a: Attachment): string => join(homeDir, "uploads", a.id, fileName(a))

/** The user's file name reduced to a safe base name; undefined when nothing usable is left. */
export const sanitizeUploadName = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  const capped = [...base].slice(0, 200).join("").trim()
  return capped === "" || capped === "." || capped === ".." ? undefined : capped
}

/**
 * The text the agent reads for a message: the user's text, then a note naming each attached file by the
 * path the agent sees. `agentHomeDir` is the task home as the agent process sees it.
 */
export const agentText = (text: string, attachments: ReadonlyArray<Attachment>, agentHomeDir: string): string => {
  if (attachments.length === 0) return text
  const note = [
    `The user attached ${attachments.length} file(s):`,
    ...attachments.map((a) => `- ${attachmentPath(agentHomeDir, a)} (${a.mimeType})`),
    "Open them with your file-reading tool (images are viewable).",
  ].join("\n")
  return text.trim() === "" ? note : `${text}\n\n${note}`
}

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_ATTACHMENT_BYTES, type Attachment } from "@cloudagents/protocol"

/**
 * Images tool calls return (a desktop screenshot), kept next to the run's items as `<runDir>/images/<id>` so the
 * transcript can show them. The id is the content's hash plus an extension for its type: the same image is stored
 * once, the id never names anything outside the folder, and the bytes behind an id never change.
 */

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
}

const MIME_TYPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mimeType, ext]) => [ext, mimeType]),
)

const ID = /^[0-9a-f]{32}\.([a-z]+)$/

export const runImagesDir = (runDir: string): string => join(runDir, "images")

/**
 * Writes one base64 image under the run and returns how the item refers to it; null for a type the app does not show
 * as an image, data that is not base64, one past the attachment size limit, or a failed write. The item then keeps
 * its `[image]` placeholder instead.
 */
export function saveRunImage(runDir: string, base64: string, mimeType: string): Attachment | null {
  const ext = Object.hasOwn(EXTENSIONS, mimeType) ? EXTENSIONS[mimeType] : undefined
  if (ext === undefined || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null
  const bytes = Buffer.from(base64, "base64")
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return null
  const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`
  try {
    const dir = runImagesDir(runDir)
    mkdirSync(dir, { recursive: true })
    // Synchronous on purpose: the item naming the image is published right after, and a client may fetch it at once.
    writeFileSync(join(dir, id), bytes)
  } catch {
    return null
  }
  return { id, mimeType }
}

/** The file and type behind an image id, or null when the id is not one `saveRunImage` makes. */
export function runImageFile(runDir: string, id: string): { readonly path: string; readonly mimeType: string } | null {
  const ext = ID.exec(id)?.[1]
  const mimeType = ext !== undefined && Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : undefined
  return mimeType === undefined ? null : { path: join(runImagesDir(runDir), id), mimeType }
}

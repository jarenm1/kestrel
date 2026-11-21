/**
 * Naming and markdown for evidence screenshots attached to a pull request. GitHub has no issue-comment attachment
 * endpoint, so the image is committed to a dedicated branch and the comment points at the blob with `?raw=true`.
 * Nothing here touches the pull request's own head or base branch.
 */

/** A count that becomes a path segment; a caller's impossible value still yields a usable name. */
const positiveInt = (value: number): string => (Number.isFinite(value) ? String(Math.max(0, Math.trunc(value))) : "0")

/** One shared branch holds every pull request's evidence files, separate from the code being reviewed. */
export const evidenceBranch = (): string => "kestrel-evidence"

/** A task id is a path segment: keep it to characters that cannot escape the directory or confuse GitHub. */
const sanitizeSegment = (value: string): string => {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return cleaned === "" ? "task" : cleaned
}

/** Repository path for one capture; the timestamp keeps a later capture from replacing an earlier one. */
export const evidencePath = (taskId: string, number: number, now: number): string =>
  `.kestrel/evidence/${sanitizeSegment(taskId)}/${positiveInt(number)}-${positiveInt(now)}.png`

/** The caption sits inside markdown's `![...]`, so brackets and backslashes must not end it early. */
const captionText = (caption: string): string => {
  const line = caption.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1")
  return line === "" ? "Desktop screenshot" : line
}

export interface EvidenceCommentInput {
  readonly caption: string
  /** The Contents API's `html_url` for the uploaded image. */
  readonly htmlUrl: string
  readonly taskId: string
  /** ISO timestamp of the capture, stated in the provenance line. */
  readonly capturedAt: string
}

/** The comment that shows the image inline and says where it came from. */
export const evidenceCommentBody = (input: EvidenceCommentInput): string => {
  const imageUrl = `${input.htmlUrl}${input.htmlUrl.includes("?") ? "&" : "?"}raw=true`
  const captured = input.capturedAt.replace(/\s+/g, " ").trim()
  return [
    `![${captionText(input.caption)}](${imageUrl})`,
    "",
    `<sub>Kestrel desktop evidence · task \`${sanitizeSegment(input.taskId)}\` · captured ${captured}</sub>`,
  ].join("\n")
}

import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { writeFileAtomic } from "./fs-atomic"

/**
 * `lease.json` in the state dir: the control plane's lease, `{"validUntil": <epoch ms>}`. The host agent writes it
 * before it acts on a lease frame; the `fence` watchdog reads it independently of the agent.
 */
const LeaseFile = Schema.Struct({ validUntil: Schema.Number.pipe(Schema.finite()) })

export const writeLeaseUntil = (path: string, validUntil: number): void => {
  writeFileAtomic(path, `${JSON.stringify({ validUntil })}\n`)
}

/** The lease's `validUntil`, or null when the file is missing, unreadable or malformed (which means expired). */
export const readLeaseUntil = (path: string): number | null => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  const decoded = Schema.decodeUnknownEither(LeaseFile)(json)
  return decoded._tag === "Right" ? decoded.right.validUntil : null
}

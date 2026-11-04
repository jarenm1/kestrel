import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { MeterRecord } from "@cloudagents/protocol"
import { ControlPaths, MAX_METER_BATCH, METER_HOST_ID_HEADER } from "@cloudagents/protocol"
import { appendLineDurable, writeFileAtomic } from "./fs-atomic"

/** Most records kept while the control plane is unreachable; the oldest go first. */
export const MAX_OUTBOX_RECORDS = 50_000
/** What remains after trimming, so trimming is not repeated on every append. */
const OUTBOX_KEEP_RECORDS = 45_000
const SHIP_TIMEOUT_MS = 30_000

const readLines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0) : []

const joinLines = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("")

/**
 * Usage records waiting for the control plane, one JSON object per line. Append is durable before it returns, so a
 * record survives a crash and is shipped after restart. Records are only removed once the control plane has
 * acknowledged them (or rejected them permanently, which moves them to `rejected.jsonl`).
 */
export class Outbox {
  private readonly path: string
  private readonly rejectedPath: string
  private count: number

  constructor(dir: string) {
    this.path = join(dir, "outbox.jsonl")
    this.rejectedPath = join(dir, "rejected.jsonl")
    this.count = readLines(this.path).length
  }

  /** Stores records; returns how many of the oldest were dropped to stay under the cap. */
  append(records: readonly MeterRecord[]): number {
    for (const record of records) {
      appendLineDurable(this.path, JSON.stringify(record))
    }
    this.count += records.length
    if (this.count <= MAX_OUTBOX_RECORDS) return 0
    const lines = readLines(this.path)
    const kept = lines.slice(lines.length - OUTBOX_KEEP_RECORDS)
    writeFileAtomic(this.path, joinLines(kept))
    this.count = kept.length
    return lines.length - kept.length
  }

  batch(limit: number): string[] {
    return readLines(this.path).slice(0, limit)
  }

  /** Removes the first `count` records, which the control plane has taken. */
  drop(count: number): void {
    const kept = readLines(this.path).slice(count)
    writeFileAtomic(this.path, joinLines(kept))
    this.count = kept.length
  }

  reject(lines: readonly string[]): void {
    for (const line of lines) {
      appendLineDurable(this.rejectedPath, line)
    }
  }
}

export interface ShipResult {
  readonly accepted: number
  readonly rejected: number
}

/**
 * Posts queued records in batches until the outbox is empty or the control plane refuses for now. A 2xx acknowledges
 * a batch. A 4xx other than 408 and 429 means the batch can never be accepted, so it is moved aside. Anything else
 * (network failure, 5xx, throttling) leaves the batch queued for the next attempt.
 */
export const shipMeterRecords = async (opts: {
  readonly outbox: Outbox
  readonly meterUrl: string
  readonly hostId: string
  readonly secret: string
}): Promise<ShipResult> => {
  const url = new URL(ControlPaths.meterRecords, opts.meterUrl).toString()
  let accepted = 0
  let rejected = 0
  for (;;) {
    const lines = opts.outbox.batch(MAX_METER_BATCH)
    if (lines.length === 0) return { accepted, rejected }
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.secret}`,
          [METER_HOST_ID_HEADER]: opts.hostId,
        },
        body: `{"records":[${lines.join(",")}]}`,
        signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
      })
    } catch {
      return { accepted, rejected }
    }
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429
    if (response.ok) {
      opts.outbox.drop(lines.length)
      accepted += lines.length
    } else if (!retryable) {
      opts.outbox.reject(lines)
      opts.outbox.drop(lines.length)
      rejected += lines.length
    } else {
      return { accepted, rejected }
    }
  }
}

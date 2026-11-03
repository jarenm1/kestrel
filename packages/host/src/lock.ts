import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { HostError } from "./errors"
import { createFileExclusive } from "./fs-atomic"
import { isProcessAlive, readProcStat } from "./proc"
import { STRICT, Uuid } from "./schema"

/**
 * Per-VM mutual exclusion: `vms/<vmId>/lock` holds the owner's pid, start time and a random token.
 *
 * Acquire creates the file with link(2) (see createFileExclusive), so a lock file is never observed
 * half-written. A lock whose owner is no longer alive (pid gone or start time changed) is stale: it is
 * moved aside with rename(2) and re-read. If the moved file is not the stale content that was inspected
 * (a live owner replaced it in between), it is put back if the slot is still free, and the caller retries.
 */

const LOCK_NAME = "lock"

const LockOwner = Schema.Struct({
  pid: Schema.Int.pipe(Schema.positive()),
  startTime: Schema.Int.pipe(Schema.nonNegative()),
  token: Uuid,
})
type LockOwner = typeof LockOwner.Type

/** Another live process holds the lock. Exit code 1: retry later. */
export class LockBusyError extends HostError {}

export interface VmLock {
  readonly path: string
  release(): void
}

interface HeldLock {
  readonly raw: string
  /** null when the content is not a valid owner record (foreign damage): treated as stale. */
  readonly owner: LockOwner | null
}

const readLockFile = (path: string): HeldLock | null => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  try {
    return { raw, owner: Schema.decodeUnknownSync(LockOwner, STRICT)(JSON.parse(raw)) }
  } catch {
    return { raw, owner: null }
  }
}

const breakStaleLock = (dir: string, path: string, observedRaw: string): void => {
  const parked = join(dir, `.${LOCK_NAME}.${randomUUID()}.stale`)
  try {
    renameSync(path, parked)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const moved = readFileSync(parked, "utf8")
  if (moved === observedRaw) {
    unlinkSync(parked)
    return
  }
  // A live owner took the lock between our read and our rename. Put its record back if the slot is still
  // free; if another process already took the slot, that process holds the lock. Either way we retry.
  createFileExclusive(path, moved)
  unlinkSync(parked)
  throw new LockBusyError(`lock ${path} changed during recovery; retry`)
}

const selfOwner = (token: string): LockOwner => {
  const stat = readProcStat(process.pid)
  if (stat === null) throw new HostError("cannot read /proc entry for this process")
  return { pid: process.pid, startTime: stat.startTime, token }
}

/** Takes the lock on `dir` without waiting. Throws LockBusyError when a live process holds it. */
export const acquireVmLock = (dir: string): VmLock => {
  const path = join(dir, LOCK_NAME)
  const token = randomUUID()
  const content = JSON.stringify(selfOwner(token))
  for (let attempt = 0; attempt < 5; attempt++) {
    if (createFileExclusive(path, content)) {
      return {
        path,
        release: () => {
          const held = readLockFile(path)
          if (held?.owner?.token === token) unlinkSync(path)
        },
      }
    }
    const held = readLockFile(path)
    if (held === null) continue
    if (held.owner !== null && isProcessAlive({ pid: held.owner.pid, startTime: held.owner.startTime })) {
      throw new LockBusyError(`VM is busy: lock held by pid ${held.owner.pid}`)
    }
    breakStaleLock(dir, path, held.raw)
  }
  throw new LockBusyError(`lock ${path} is contended; retry`)
}

/** Runs `fn` while holding the VM lock, releasing it afterwards even when `fn` throws. */
export const withVmLock = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const lock = acquireVmLock(dir)
  try {
    return await fn()
  } finally {
    lock.release()
  }
}

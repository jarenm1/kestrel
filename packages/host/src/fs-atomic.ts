import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const writeAll = (fd: number, data: Buffer): void => {
  let offset = 0
  while (offset < data.length) {
    offset += writeSync(fd, data, offset, data.length - offset)
  }
}

/** fsync a directory so a rename, link or create inside it survives a crash. */
export const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Writes `data` to a fresh, fsynced temp file next to `path` and returns its name. */
const writeTemp = (path: string, data: string): string => {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(tmp, "wx", 0o600)
  try {
    writeAll(fd, Buffer.from(data, "utf8"))
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(tmp)
    throw error
  }
  closeSync(fd)
  return tmp
}

/**
 * Replaces `path` with `data` atomically: write a temp file in the same directory, fsync it, rename it
 * over `path`, then fsync the directory. Readers see the old or the new file, never a partial one.
 */
export const writeFileAtomic = (path: string, data: string): void => {
  const tmp = writeTemp(path, data)
  try {
    renameSync(tmp, path)
  } catch (error) {
    unlinkSync(tmp)
    throw error
  }
  fsyncDir(dirname(path))
}

/**
 * Creates `path` with `data` only if it does not exist. Uses link(2), which fails with EEXIST instead of
 * overwriting, so two racing creators cannot both win. Returns false when the file already exists.
 */
export const createFileExclusive = (path: string, data: string): boolean => {
  const tmp = writeTemp(path, data)
  try {
    linkSync(tmp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    unlinkSync(tmp)
  }
  fsyncDir(dirname(path))
  return true
}

/** Appends one newline-terminated line and fsyncs it before returning. */
export const appendLineDurable = (path: string, line: string): void => {
  const fd = openSync(path, "a", 0o600)
  try {
    writeAll(fd, Buffer.from(`${line}\n`, "utf8"))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

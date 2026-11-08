import { randomUUID } from "node:crypto"
import { open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Replaces `file` with `data` via a synced temp file and rename. Once it resolves, readers see the new content; if it
 * throws, the old file is still in place and no temp file is left behind.
 */
export const replaceFile = async (file: string, data: string): Promise<void> => {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, "w")
    try {
      await handle.writeFile(data, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/**
 * Persists the rename of `file` by syncing its directory entry; without this a crash can roll the entry back. Windows
 * cannot fsync a directory (EPERM), so it is skipped there.
 */
export const syncDir = async (file: string): Promise<void> => {
  if (process.platform === "win32") return
  const dir = await open(dirname(file), "r")
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

/** Replaces `file` with `data` via a synced temp file and rename, then syncs the directory entry. */
export const writeAtomic = async (file: string, data: string): Promise<void> => {
  await replaceFile(file, data)
  await syncDir(file)
}

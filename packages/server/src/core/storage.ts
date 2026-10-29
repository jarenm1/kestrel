import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

/** How often the box measures every thread's storage and enforces `taskDiskMax`. */
export const STORAGE_CHECK_MS = 30_000

/**
 * Growth between two checks that counts as still writing. A cleanup run over the limit keeps writing a little of its
 * own (the harness's session log), so only growth past this stops the thread again.
 */
export const STORAGE_GROWTH_SLACK = 64 * 1024 ** 2

/**
 * Disk space used by everything under `roots`, like `du`: allocated blocks where the OS reports them (apparent size
 * on Windows), each hard-linked file counted once, symlinks never followed. Missing roots count as empty.
 */
export const diskUsage = async (roots: ReadonlyArray<string>): Promise<number> => {
  const seen = new Set<string>()
  let total = 0
  const visit = async (path: string): Promise<void> => {
    let st
    try {
      st = await lstat(path)
    } catch {
      return // Gone between readdir and lstat, or a root that does not exist yet.
    }
    if (st.nlink > 1) {
      const inode = `${st.dev}:${st.ino}`
      if (seen.has(inode)) return
      seen.add(inode)
    }
    total += st.blocks > 0 ? st.blocks * 512 : st.size
    if (!st.isDirectory()) return
    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      return
    }
    for (const name of names) await visit(join(path, name))
  }
  for (const root of roots) await visit(root)
  return total
}

/** "51.3 GB", "40 MB": a size for messages to the user and the agent. */
export const formatBytes = (bytes: number): string => {
  const [unit, size] = bytes >= 1024 ** 3 ? ["GB", 1024 ** 3] : bytes >= 1024 ** 2 ? ["MB", 1024 ** 2] : ["KB", 1024]
  return `${(bytes / size).toFixed(1).replace(/\.0$/, "")} ${unit}`
}

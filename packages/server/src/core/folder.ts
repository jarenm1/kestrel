import { constants } from "node:fs"
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from "node:fs/promises"
import { join, sep } from "node:path"
import type { FolderFile, FolderFiles } from "@cloudagents/protocol"

/**
 * Listing and reading files of folders the agent writes (the thread workspace, its home). The agent can swap any
 * directory under them for a symlink at any moment, so nothing here may follow one out of the folder: directories are
 * read through an open descriptor whose real path is checked, and a file is served only if the descriptor it was
 * opened as is the inode its checked real path names.
 */

/** Hidden unless asked for: dot names (caches, configs, the box's own `.kestrel`/`.cloudagents`) and dependency dirs. */
const isHidden = (name: string): boolean => name.startsWith(".") || name === "node_modules" || name === "__pycache__"

const inside = (root: string, real: string): boolean => real === root || real.startsWith(root + sep)

/** Linux exposes an open descriptor's directory as `/proc/self/fd/<fd>`: read through it, the path cannot change. */
const PROC_FD = process.platform === "linux"

/**
 * Reads directory `dir` if it really is inside `root` (a real path), calling `read` with a path that names that same
 * directory. Null when it is not inside, or is gone.
 */
async function withDirInside<A>(root: string, dir: string, read: (path: string) => Promise<A>): Promise<A | null> {
  if (!PROC_FD) {
    // Elsewhere (local development on macOS/Windows, where agents are not sandboxed) the real path is checked instead.
    const real = await realpath(dir).catch(() => null)
    return real !== null && inside(root, real) ? read(real) : null
  }
  let handle: FileHandle
  try {
    handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const fdPath = `/proc/self/fd/${handle.fd}`
    return inside(root, await readlink(fdPath)) ? await read(fdPath) : null
  } finally {
    await handle.close()
  }
}

/**
 * The regular files under `folder`, depth first with each directory's entries sorted by name, at most `limit`
 * (`truncated` when there were more). Symlinks are left out and never followed; unreadable directories are skipped.
 * `skipTop` names entries of the folder itself to leave out (the workspace's checkouts). A missing folder has none.
 */
export async function listFolder(
  folder: string,
  opts: { readonly hidden: boolean; readonly limit: number; readonly skipTop: ReadonlySet<string> },
): Promise<FolderFiles> {
  const root = await realpath(folder).catch(() => null)
  if (root === null) return { files: [], truncated: false }
  const files: FolderFile[] = []
  // One past the limit is enough to know the listing was cut.
  const full = () => files.length > opts.limit
  const walk = async (rel: string): Promise<void> => {
    await withDirInside(root, rel === "" ? root : join(root, rel), async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const kept = entries
        .filter((e) => (opts.hidden || !isHidden(e.name)) && !(rel === "" && opts.skipTop.has(e.name)))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of kept) {
        if (full()) return
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) {
          // Through the same descriptor path, and lstat: a name swapped for a symlink since readdir is not followed.
          const info = await lstat(join(dir, entry.name)).catch(() => null)
          if (info?.isFile()) files.push({ path, size: info.size, modifiedAt: info.mtime.toISOString() })
        }
      }
    })
  }
  await walk("")
  return { files: files.slice(0, opts.limit), truncated: full() }
}

/** Why `openInside` refused: a malformed path, or no regular file there inside the folder. */
export class FileRefused extends Error {
  constructor(readonly reason: "bad-path" | "not-found") {
    super(reason === "bad-path" ? "not a file path" : "no such file")
  }
}

/**
 * Opens the regular file at `path` (relative, `/`-separated) under `folder` for reading. Refuses (FileRefused) a path
 * with empty, `.` or `..` segments, anything that is not a regular file, and a file whose real location is outside
 * the folder, including one reached through a symlinked directory that was swapped back after the open.
 */
export async function openInside(folder: string, path: string): Promise<{ handle: FileHandle; size: number }> {
  const segments = path.split("/")
  if (path.includes("\0") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new FileRefused("bad-path")
  }
  const root = await realpath(folder).catch(() => null)
  if (root === null) throw new FileRefused("not-found")
  const full = join(root, ...segments)
  let handle: FileHandle
  try {
    // O_NOFOLLOW refuses a final symlink. O_NONBLOCK keeps a named pipe from blocking the open until a writer comes;
    // it changes nothing for a regular file. Both are 0 where the platform has none (Windows).
    handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    throw new FileRefused("not-found")
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new FileRefused("not-found")
    const real = await realpath(full).catch(() => null)
    const named = real === null || !inside(root, real) ? null : await stat(real).catch(() => null)
    // The path resolves inside the folder now, and to the very file that was opened.
    if (named === null || named.dev !== opened.dev || named.ino !== opened.ino) throw new FileRefused("not-found")
    return { handle, size: opened.size }
  } catch (e) {
    await handle.close()
    throw e
  }
}

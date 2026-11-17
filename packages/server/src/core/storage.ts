import { chmod, lstat, readdir, rm } from "node:fs/promises"
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

/**
 * Package-manager and tool caches an agent fills in its thread's home, relative to that home. Each is refetched on
 * demand, so an archived thread drops them; the workspace, git config and CLI sessions in the home stay.
 */
export const THREAD_HOME_CACHES: ReadonlyArray<string> = [
  ".cache", // XDG: uv, pip, Playwright browsers, go-build, node-gyp, Nix's fetcher cache, ...
  ".bun/install/cache",
  ".npm",
  ".local/share/pnpm/store",
  ".yarn/berry/cache",
  // A private Nix store: the sandbox's /nix/store is read-only, so `nix` falls back to `~/.local/share/nix/root`.
  ".local/share/nix",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
]

/** Gives the owner full access to every directory under `path` (Nix and Go leave theirs read-only). Symlinks are not followed. */
const makeWritable = async (path: string): Promise<void> => {
  const st = await lstat(path)
  if (!st.isDirectory()) return
  if ((st.mode & 0o700) !== 0o700) await chmod(path, st.mode | 0o700)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(join(path, entry.name))
  }
}

/** Whether every directory from `home` down to `rel`'s parent is a real directory: the agent owns the home, and a symlink there could aim the removal anywhere. */
const parentsAreDirectories = async (home: string, rel: string): Promise<boolean> => {
  let path = home
  for (const part of rel.split("/").slice(0, -1)) {
    path = join(path, part)
    const st = await lstat(path).catch(() => null)
    if (st === null || !st.isDirectory()) return false
  }
  return true
}

/**
 * Removes `THREAD_HOME_CACHES` from a thread's home. Call it only while nothing of the thread runs: a process could
 * swap a parent directory for a symlink between the check and the removal. A cache whose parent is not a real
 * directory is left alone; a cache that is itself a symlink loses the link, never its target.
 */
export const dropThreadCaches = async (home: string): Promise<void> => {
  for (const rel of THREAD_HOME_CACHES) {
    if (!(await parentsAreDirectories(home, rel))) continue
    const path = join(home, rel)
    try {
      await rm(path, { recursive: true, force: true })
    } catch {
      // A read-only directory inside (a Nix store, Go's module cache) stops the removal; open it up and retry.
      await makeWritable(path)
      await rm(path, { recursive: true, force: true })
    }
  }
}

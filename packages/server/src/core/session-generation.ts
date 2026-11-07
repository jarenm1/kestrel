import { randomUUID } from "node:crypto"
import { link, open, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"

const readGeneration = async (dir: string, path: string): Promise<string> => {
  const generation = await readFile(path, "utf8")
  // A different process may have published the link but not yet synced its directory entry.
  if (process.platform !== "win32") {
    const directory = await open(dir, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  return generation
}

/** Publish a complete generation once, without replacing another process's choice. */
export const sessionGeneration = async (dir: string): Promise<string> => {
  const path = join(dir, ".kestrel-session-generation")
  try {
    return await readGeneration(dir, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, "wx", 0o600)
    try {
      await file.writeFile(randomUUID(), "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(temp, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    return await readGeneration(dir, path)
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

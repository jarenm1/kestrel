import { randomUUID } from "node:crypto"
import { link, open, readFile, unlink } from "node:fs/promises"
import { join } from "node:path"

/** Publish a complete generation once, without replacing another process's choice. */
export const sessionGeneration = async (dir: string): Promise<string> => {
  const path = join(dir, ".kestrel-session-generation")
  try {
    return await readFile(path, "utf8")
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
      if (process.platform !== "win32") {
        const directory = await open(dir, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    return await readFile(path, "utf8")
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

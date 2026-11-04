import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The box secret a Nest box keeps after enrollment, in the data dir. Owner-only: the box is the only reader. */
const SECRET_FILE = "box-secret"

export const storedSecretPath = (dataDir: string): string => join(dataDir, SECRET_FILE)

/** The enrolled secret, or null when this box has not enrolled. A file that exists but is empty is an error. */
export const readStoredSecret = (dataDir: string): string | null => {
  let raw: string
  try {
    raw = readFileSync(storedSecretPath(dataDir), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const secret = raw.trim()
  if (secret === "") throw new Error(`stored box secret at ${storedSecretPath(dataDir)} is empty`)
  return secret
}

/** Writes the secret atomically, readable by its owner only. */
export const writeStoredSecret = (dataDir: string, secret: string): void => {
  mkdirSync(dataDir, { recursive: true })
  const path = storedSecretPath(dataDir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${secret}\n`, { mode: 0o600, flag: "w" })
  renameSync(tmp, path)
}

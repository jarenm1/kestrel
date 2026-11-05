import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { join } from "node:path"

/** The box secret a Nest box keeps after enrollment, in the data dir. Owner-only: the box is the only reader. */
const SECRET_FILE = "box-secret"

export const storedSecretPath = (dataDir: string): string => join(dataDir, SECRET_FILE)

/** The enrolled secret, or null when this box has not enrolled. An empty file is a write that never reached disk. */
export const readStoredSecret = (dataDir: string): string | null => {
  let raw: string
  try {
    raw = readFileSync(storedSecretPath(dataDir), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const secret = raw.trim()
  if (secret === "") return null
  return secret
}

/** Writes the secret atomically and durably, readable by its owner only: synced before the rename, the directory after. */
export const writeStoredSecret = (dataDir: string, secret: string): void => {
  mkdirSync(dataDir, { recursive: true })
  const path = storedSecretPath(dataDir)
  const tmp = `${path}.${process.pid}.tmp`
  const file = openSync(tmp, "w", 0o600)
  try {
    writeSync(file, `${secret}\n`)
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
  renameSync(tmp, path)
  const directory = openSync(dataDir, "r")
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

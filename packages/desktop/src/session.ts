import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { app, safeStorage } from "electron"

/**
 * The control-plane session id, kept encrypted by the OS credential store when Electron can reach one.
 * The id is a bearer secret for the user's account, so it never goes to the renderer or the app's storage.
 */
export class SessionStore {
  private readonly file: string

  constructor(file = join(app.getPath("userData"), "session")) {
    this.file = file
  }

  async get(): Promise<string | null> {
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch {
      return null
    }
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8")
    } catch {
      return null
    }
  }

  async set(id: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const raw = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(id) : Buffer.from(id, "utf8")
    await writeFile(this.file, raw, { mode: 0o600 })
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true })
  }
}

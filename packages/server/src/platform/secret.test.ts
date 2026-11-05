import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readStoredSecret, storedSecretPath, writeStoredSecret } from "./secret"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const dataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "secret-test-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe("stored box secret", () => {
  test("a written secret reads back", async () => {
    const dir = await dataDir()
    writeStoredSecret(dir, "s3cret-value")
    expect(readStoredSecret(dir)).toBe("s3cret-value")
  })

  test("an empty secret file is not an enrollment, so enrollment can run again", async () => {
    const dir = await dataDir()
    await writeFile(storedSecretPath(dir), "")
    expect(readStoredSecret(dir)).toBeNull()
  })
})

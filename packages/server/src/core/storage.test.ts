import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskUsage } from "./storage"

const MB = 1024 ** 2

describe("diskUsage", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-storage-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("sums files across roots and nested directories; missing roots are empty", async () => {
    await mkdir(join(root, "a", "deep"), { recursive: true })
    await mkdir(join(root, "b"))
    await writeFile(join(root, "a", "deep", "one.bin"), Buffer.alloc(2 * MB, 1))
    await writeFile(join(root, "b", "two.bin"), Buffer.alloc(3 * MB, 1))
    const used = await diskUsage([join(root, "a"), join(root, "b"), join(root, "missing")])
    expect(used).toBeGreaterThanOrEqual(5 * MB)
    expect(used).toBeLessThan(6 * MB)
  })

  test("a hard-linked file counts once, even across roots", async () => {
    await mkdir(join(root, "a"))
    await mkdir(join(root, "b"))
    await writeFile(join(root, "a", "big.bin"), Buffer.alloc(4 * MB, 1))
    await link(join(root, "a", "big.bin"), join(root, "b", "same.bin"))
    const used = await diskUsage([join(root, "a"), join(root, "b")])
    expect(used).toBeLessThan(5 * MB)
  })

  test("symlinks are not followed, so space outside the thread is not charged to it", async () => {
    const outside = join(root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "big.bin"), Buffer.alloc(8 * MB, 1))
    await mkdir(join(root, "thread"))
    try {
      await symlink(outside, join(root, "thread", "link"), "dir")
    } catch {
      return // Windows without the symlink privilege; the POSIX boxes this runs on always allow it.
    }
    expect(await diskUsage([join(root, "thread")])).toBeLessThan(MB)
  })
})

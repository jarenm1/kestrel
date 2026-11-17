import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diskUsage, dropThreadCaches } from "./storage"

const exists = (path: string) => access(path).then(() => true, () => false)

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

describe("dropThreadCaches", () => {
  let root: string
  let home: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kestrel-caches-"))
    home = join(root, "home")
    await mkdir(home)
  })
  afterEach(async () => {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  test("removes the caches, read-only Nix store directories included, and keeps the rest of the home", async () => {
    await mkdir(join(home, ".bun", "install", "cache", "pkg"), { recursive: true })
    await writeFile(join(home, ".bun", "install", "cache", "pkg", "index.js"), "x")
    await mkdir(join(home, ".bun", "bin"), { recursive: true })
    const store = join(home, ".local", "share", "nix", "root", "nix", "store", "abc-hello")
    await mkdir(store, { recursive: true })
    await writeFile(join(store, "hello"), "x")
    await chmod(store, 0o555)
    await chmod(join(home, ".local", "share", "nix", "root", "nix", "store"), 0o555)
    await mkdir(join(home, ".cache", "uv"), { recursive: true })
    await writeFile(join(home, ".gitconfig"), "[user]\n")

    await dropThreadCaches(home)

    expect(await exists(join(home, ".bun", "install", "cache"))).toBe(false)
    expect(await exists(join(home, ".local", "share", "nix"))).toBe(false)
    expect(await exists(join(home, ".cache"))).toBe(false)
    expect(await exists(join(home, ".bun", "bin"))).toBe(true)
    expect(await exists(join(home, ".local", "share"))).toBe(true)
    expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe("[user]\n")
  })

  test("never deletes through a symlink the agent left in the home", async () => {
    const outside = join(root, "outside")
    await mkdir(join(outside, "install", "cache"), { recursive: true })
    await writeFile(join(outside, "install", "cache", "keep"), "x")
    await mkdir(join(outside, "uv"))
    try {
      await symlink(outside, join(home, ".bun"))
      await symlink(outside, join(home, ".cache"))
    } catch {
      return // Windows without the symlink privilege; the POSIX boxes this runs on always allow it.
    }

    await dropThreadCaches(home)

    expect(await exists(join(outside, "install", "cache", "keep"))).toBe(true)
    expect(await exists(join(outside, "uv"))).toBe(true)
    expect(await exists(join(home, ".bun"))).toBe(true)
    expect(await exists(join(home, ".cache"))).toBe(false)
  })

  test("a home with none of the caches, or no home at all, is left as it is", async () => {
    await dropThreadCaches(home)
    await dropThreadCaches(join(root, "missing"))
    expect(await exists(home)).toBe(true)
  })
})

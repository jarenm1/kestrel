import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileRefused, listFolder, openInside } from "./folder"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** A temp dir with `folder/` (the listed/served folder) and `outside/secret.txt` next to it. */
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "box-folder-"))
  roots.push(root)
  const folder = join(root, "folder")
  await mkdir(join(root, "outside"), { recursive: true })
  await writeFile(join(root, "outside", "secret.txt"), "secret\n")
  await mkdir(folder)
  return { folder, outside: join(root, "outside") }
}

const write = async (folder: string, path: string, text = "x") => {
  await mkdir(join(folder, path, ".."), { recursive: true })
  await writeFile(join(folder, path), text)
}

const paths = (listing: { files: ReadonlyArray<{ path: string }> }) => listing.files.map((f) => f.path)

// Creating symlinks on Windows needs a privilege test machines rarely have.
const symlinks = process.platform !== "win32"

describe("listFolder", () => {
  test("hides dot names and dependency dirs unless asked, and skips the named top-level entries", async () => {
    const { folder } = await setup()
    await write(folder, "render.png", "png")
    await write(folder, "projects/castle.blend", "blend")
    await write(folder, ".cache/blender/thumb.bin")
    await write(folder, "projects/.autosave.blend")
    await write(folder, "web/node_modules/pkg/index.js")
    await write(folder, "repo/README.md")

    const shown = await listFolder(folder, { hidden: false, limit: 100, skipTop: new Set(["repo"]) })
    expect(paths(shown)).toEqual(["projects/castle.blend", "render.png"])
    expect(shown.truncated).toBe(false)
    expect(shown.files.find((f) => f.path === "render.png")?.size).toBe(3)

    const all = await listFolder(folder, { hidden: true, limit: 100, skipTop: new Set(["repo"]) })
    expect(paths(all)).toEqual([
      ".cache/blender/thumb.bin",
      "projects/.autosave.blend",
      "projects/castle.blend",
      "render.png",
      "web/node_modules/pkg/index.js",
    ])
  })

  test("cuts the listing at the limit and says so", async () => {
    const { folder } = await setup()
    for (const name of ["a", "b", "c"]) await write(folder, name)
    expect(await listFolder(folder, { hidden: false, limit: 2, skipTop: new Set() })).toMatchObject({
      truncated: true,
      files: [{ path: "a" }, { path: "b" }],
    })
    expect((await listFolder(folder, { hidden: false, limit: 3, skipTop: new Set() })).truncated).toBe(false)
  })

  test("a missing folder has no files", async () => {
    const { folder } = await setup()
    expect(await listFolder(join(folder, "nope"), { hidden: false, limit: 10, skipTop: new Set() })).toEqual({
      files: [],
      truncated: false,
    })
  })

  test.skipIf(!symlinks)("never lists or follows symlinks", async () => {
    const { folder, outside } = await setup()
    await write(folder, "real.txt")
    await symlink(outside, join(folder, "linked-dir"))
    await symlink(join(outside, "secret.txt"), join(folder, "linked-file.txt"))
    expect(paths(await listFolder(folder, { hidden: true, limit: 100, skipTop: new Set() }))).toEqual(["real.txt"])
  })
})

describe("openInside", () => {
  const read = async (folder: string, path: string) => {
    const { handle, size } = await openInside(folder, path)
    try {
      return { size, text: (await handle.readFile()).toString() }
    } finally {
      await handle.close()
    }
  }

  const refusal = (folder: string, path: string) =>
    openInside(folder, path).then(
      async ({ handle }) => {
        await handle.close()
        return "opened"
      },
      (e: unknown) => (e instanceof FileRefused ? e.reason : `threw ${String(e)}`),
    )

  test("opens a regular file inside the folder", async () => {
    const { folder } = await setup()
    await write(folder, "projects/castle.blend", "blend data")
    expect(await read(folder, "projects/castle.blend")).toEqual({ size: 10, text: "blend data" })
  })

  test("refuses paths that are not plain relative file paths", async () => {
    const { folder } = await setup()
    await write(folder, "a.txt")
    for (const path of ["", "../outside/secret.txt", "projects/../a.txt", "./a.txt", "a//b", "/a.txt", "a.txt\0"]) {
      expect(await refusal(folder, path)).toBe("bad-path")
    }
  })

  test("refuses directories and missing files", async () => {
    const { folder } = await setup()
    await write(folder, "projects/castle.blend")
    expect(await refusal(folder, "projects")).toBe("not-found")
    expect(await refusal(folder, "projects/none.blend")).toBe("not-found")
  })

  test.skipIf(!symlinks)("refuses a symlink, and a file reached through a symlinked directory", async () => {
    const { folder, outside } = await setup()
    await symlink(join(outside, "secret.txt"), join(folder, "secret.txt"))
    await symlink(outside, join(folder, "linked"))
    expect(await refusal(folder, "secret.txt")).toBe("not-found")
    expect(await refusal(folder, "linked/secret.txt")).toBe("not-found")
  })

  test.skipIf(process.platform !== "linux")("refuses a named pipe without waiting for a writer", async () => {
    const { folder } = await setup()
    execFileSync("mkfifo", [join(folder, "pipe")])
    expect(await refusal(folder, "pipe")).toBe("not-found")
  })
})

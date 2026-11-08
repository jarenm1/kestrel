import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { sessionGeneration } from "./session-generation"

test("concurrent initializers publish one complete generation and deletion resets it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-generation-"))
  try {
    const generations = await Promise.all(Array.from({ length: 40 }, () => sessionGeneration(dir)))
    expect(new Set(generations).size).toBe(1)
    const first = generations[0]!
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readFile(join(dir, ".kestrel-session-generation"), "utf8")).toBe(first)
    await unlink(join(dir, ".kestrel-session-generation"))
    expect(await sessionGeneration(dir)).not.toBe(first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("independent processes agree on the first generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kestrel-generation-process-"))
  try {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "session-generation.ts")).href
    const children = Array.from({ length: 12 }, () => Bun.spawn(
      [process.execPath, "-e", `import { sessionGeneration } from ${JSON.stringify(moduleUrl)}; console.log(await sessionGeneration(process.argv[1]));`, dir],
      { stdout: "pipe", stderr: "pipe" },
    ))
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      output: (await new Response(child.stdout).text()).trim(),
      error: await new Response(child.stderr).text(),
    })))
    expect(results.map((result) => result.error)).toEqual(Array(12).fill(""))
    expect(results.map((result) => result.code)).toEqual(Array(12).fill(0))
    expect(new Set(results.map((result) => result.output)).size).toBe(1)
    expect(results[0]!.output).toBe(await readFile(join(dir, ".kestrel-session-generation"), "utf8"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

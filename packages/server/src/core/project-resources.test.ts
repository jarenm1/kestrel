import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { Effect, Either } from "effect"
import { InternalError } from "@cloudagents/protocol"
import { loadProjectResources, projectResourcesFor as resourceEffect, ENGINE_TARGET, CACHE_TARGET } from "./project-resources"
import { buildBwrapArgv } from "../sandbox"

const root = mkdtempSync(join(tmpdir(), "project-resources-"))
afterEach(() => rmSync(root, { recursive: true, force: true }))
const projectResourcesFor = (...args: Parameters<typeof resourceEffect>) => Effect.runSync(resourceEffect(...args))
const task = { owner: "alice", checkouts: [{ repo: "org/game" }] }
const fixture = () => {
  for (const dir of ["engine", "cache", "data"]) mkdirSync(join(root, dir), { recursive: true })
  const grant = { owner: "alice", repo: "org/game", trustGroup: "team", engineDir: join(root, "engine"), cacheDir: join(root, "cache") }
  const write = (file = join(root, "manifest.json"), grants = [grant]) => {
    writeFileSync(file, JSON.stringify({ version: 1, grants }))
    return file
  }
  return { grant, write, load: (file = write()) => loadProjectResources(file, join(root, "data")) }
}

describe("project resources", () => {
  test("rejects manifests in writable caches or data, including an aliased data directory", () => {
    const { write, load } = fixture()
    expect(() => load(write(join(root, "cache", "manifest.json")))).toThrow("outside every writable cache")
    const file = write(join(root, "data", "manifest.json"))
    expect(() => load(file)).toThrow("outside the data directory")
    symlinkSync(join(root, "data"), join(root, "data-alias"))
    expect(() => loadProjectResources(file, join(root, "data-alias"))).toThrow("outside the data directory")
  })

  test("rejects noncanonical paths and both file and ancestor symlinks", () => {
    const { write, load } = fixture()
    const file = write()
    symlinkSync(file, join(root, "manifest-link.json"))
    symlinkSync(root, join(root, "alias"))
    for (const path of [join(root, "manifest-link.json"), join(root, "alias", "manifest.json"), `${root}/./manifest.json`, `${root}/cache/../manifest.json`]) {
      expect(() => load(path)).toThrow("canonical absolute regular file")
    }
  })

  test("rejects duplicate grants and returns typed errors for multiple matches", () => {
    const { grant, write, load } = fixture()
    expect(() => load(write(undefined, [grant, grant]))).toThrow("duplicate project resource grant")
    const grants = load(write(undefined, [grant, { ...grant, repo: "org/other" }]))
    const result = Effect.runSync(Effect.either(resourceEffect(grants, { ...task, checkouts: [...task.checkouts, { repo: "org/other" }] })))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InternalError)
      expect(result.left.message).toContain("multiple project resource grants")
    }
  })

  test("canonical checkout URLs select the same grant as repository slugs", () => {
    const grants = fixture().load()
    expect(projectResourcesFor(grants, { ...task, checkouts: [{ repo: "https://github.com/org/game.git" }] })).toEqual(projectResourcesFor(grants, task))
  })

  test("post-load directory swaps fail with typed errors, including missing paths", () => {
    const { grant, load } = fixture()
    const grants = load()
    renameSync(grant.cacheDir, join(root, "moved-cache"))
    for (const swapped of [false, true]) {
      if (swapped) symlinkSync(join(root, "moved-cache"), grant.cacheDir)
      const result = Effect.runSync(Effect.either(resourceEffect(grants, task)))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InternalError)
    }
  })

  test("grants only the exact owner and checkout and rejects unsafe paths and overlap", () => {
    mkdirSync(join(root, "engine"), { recursive: true })
    mkdirSync(join(root, "cache"))
    const grant = { owner: "alice", repo: "org/game", trustGroup: "team", engineDir: join(root, "engine"), cacheDir: join(root, "cache") }
    const manifest = join(root, "manifest.json")
    const load = (grants: unknown[]) => {
      writeFileSync(manifest, JSON.stringify({ version: 1, grants }))
      return loadProjectResources(manifest, join(root, "data"))
    }
    const grants = load([grant])
    const resources = projectResourcesFor(grants, { owner: "alice", checkouts: [{ repo: "org/game" }] })
    expect(resources.roTargetBinds).toEqual([{ host: grant.engineDir, sandbox: ENGINE_TARGET }])
    expect(resources.binds).toEqual([{ host: grant.cacheDir, sandbox: CACHE_TARGET }])
    expect(projectResourcesFor(grants, { owner: "bob", checkouts: [{ repo: "org/game" }] }).binds).toEqual([])
    expect(projectResourcesFor(grants, { owner: "alice", checkouts: [{ repo: "org/other" }] }).binds).toEqual([])
    expect(() => load([grant, { ...grant, owner: "bob", trustGroup: "other" }])).toThrow()
    expect(load([grant, { ...grant, owner: "bob" }])).toHaveLength(2)
    expect(() => load([{ ...grant, cacheDir: grant.engineDir }])).toThrow()
    symlinkSync(grant.cacheDir, join(root, "link"))
    expect(() => load([{ ...grant, cacheDir: join(root, "link") }])).toThrow()
    expect(() => load([{ ...grant, zenDdcUrl: "https://user:secret@example.com" }])).toThrow()
  })
})

test.if(!!process.env.BWRAP_SMOKE)("two sandbox launches share cache and cannot write the engine", () => {
  for (const dir of ["engine", "cache", "one", "two", "home1", "home2", "mirror"]) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, "engine", "version"), "synthetic-engine")
  const manifest = join(root, "manifest.json")
  writeFileSync(manifest, JSON.stringify({ version: 1, grants: [{ owner: "alice", repo: "org/game", trustGroup: "team", engineDir: join(root, "engine"), cacheDir: join(root, "cache") }] }))
  const grants = loadProjectResources(manifest, join(root, "data"))
  const resources = projectResourcesFor(grants, { owner: "alice", checkouts: [{ repo: "org/game" }] })
  const launch = (workspace: string, home: string, command: string) => {
    const argv = buildBwrapArgv({ level: "strict", workspacePath: join(root, workspace), cwd: join(root, workspace), mirrorDir: join(root, "mirror"), homeDir: join(root, home), env: { PATH: process.env.PATH ?? "" }, command, binds: resources.binds, roTargetBinds: resources.roTargetBinds })
    return spawnSync(process.env.BWRAP_SMOKE!, argv.slice(1), { encoding: "utf8" })
  }
  const first = launch("one", "home1", `printf cache > ${CACHE_TARGET}/result; ! printf changed > ${ENGINE_TARGET}/version`)
  expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: expect.stringContaining("Read-only file system") })
  const second = launch("two", "home2", `test "$(cat ${CACHE_TARGET}/result)" = cache && test "$(cat ${ENGINE_TARGET}/version)" = synthetic-engine`)
  expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: "" })
})

import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { InternalError } from "@cloudagents/protocol"
import { parseRepoRef } from "./repo-ref"

const Grant = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  trustGroup: Schema.String,
  engineDir: Schema.String,
  cacheDir: Schema.String,
  zenDdcUrl: Schema.optional(Schema.String),
})
const Manifest = Schema.Struct({ version: Schema.Literal(1), grants: Schema.Array(Grant) })
type Grant = Schema.Schema.Type<typeof Grant>

export const ENGINE_TARGET = "/kestrel-project-resources/engine"
export const CACHE_TARGET = "/kestrel-project-resources/cache"
const SHARED_CACHES = "shared-caches"
/** Points Unreal's filesystem derived data cache at the mounted project cache, with no Zen server needed. */
const cacheEnv = { KESTREL_PROJECT_CACHE: CACHE_TARGET, UE_LOCAL_DATA_CACHE_PATH: CACHE_TARGET }

const overlaps = (a: string, b: string): boolean => {
  const r = relative(a, b)
  return r === "" || (!r.startsWith("../") && r !== ".." && !isAbsolute(r))
}
const intersects = (a: string, b: string): boolean => overlaps(a, b) || overlaps(b, a)

/** Resolve existing ancestors even before a new box's data directory has been created. */
const canonicalDataPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error
    return join(canonicalDataPath(dirname(path)), basename(path))
  }
}

/** Load only host-provisioned directories; the operator must keep their ancestors host-controlled. */
export const loadProjectResources = (file: string, dataDir: string): readonly Grant[] => {
  if (!isAbsolute(file) || normalize(file) !== file || realpathSync(file) !== file || !statSync(file).isFile()) {
    throw new Error("project resource manifest must be a canonical absolute regular file without symlinks")
  }
  const canonicalDataDir = canonicalDataPath(resolve(dataDir))
  if (overlaps(canonicalDataDir, file)) throw new Error("project resource manifest must be outside the data directory")
  if (intersects(dataDir, "/kestrel-project-resources")) throw new Error("data directory overlaps project resource targets")
  const grants = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(file, "utf8")), { onExcessProperty: "error" }).grants
  if (grants.some((grant) => overlaps(grant.cacheDir, file))) throw new Error("project resource manifest must be outside every writable cache")
  const identities = new Set<string>()
  for (const grant of grants) {
    const ref = parseRepoRef(grant.repo)
    if (!/^[A-Za-z0-9-]+$/.test(grant.owner) || !/^[A-Za-z0-9._-]+$/.test(grant.trustGroup) ||
        ref?.github === null || ref === null || ref.repo !== grant.repo) throw new Error("invalid project resource identity")
    const key = `${grant.owner}\0${grant.repo}`
    if (identities.has(key)) throw new Error("duplicate project resource grant")
    identities.add(key)
    for (const dir of [grant.engineDir, grant.cacheDir]) {
      if (!isAbsolute(dir) || normalize(dir) !== dir || realpathSync(dir) !== dir || !statSync(dir).isDirectory() || intersects(dir, canonicalDataDir) ||
          ["/home", "/proc", "/sys", "/dev", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/nix", "/run"].some((reserved) => intersects(dir, reserved))) {
        throw new Error("project resource directories must be canonical, existing directories outside the data directory")
      }
    }
    if (grant.zenDdcUrl !== undefined) {
      const url = new URL(grant.zenDdcUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid Zen DDC URL")
    }
  }
  for (const [i, a] of grants.entries()) for (const b of grants.slice(i)) {
    if (intersects(a.engineDir, b.cacheDir) || (a !== b && intersects(a.cacheDir, b.engineDir))) throw new Error("engine and cache directories overlap")
    if (a !== b && intersects(a.cacheDir, b.cacheDir) && (a.cacheDir !== b.cacheDir || a.trustGroup !== b.trustGroup)) throw new Error("cache directories overlap across trust groups")
  }
  return grants
}

/**
 * Creates `<dataDir>/shared-caches/<taskOwner>/<repoOwner>/<repo>` one component at a time, so a symlink at any level
 * is refused rather than followed. The components are validated first, so the path stays inside `dataDir`.
 */
const ensureSharedCache = (dataDir: string, taskOwner: string, repo: { owner: string; name: string }): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskOwner)) throw new Error("invalid task owner for shared cache")
  let dir = canonicalDataPath(resolve(dataDir))
  mkdirSync(dir, { recursive: true })
  for (const part of [SHARED_CACHES, taskOwner, repo.owner, repo.name]) {
    dir = join(dir, part)
    try {
      mkdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    if (!lstatSync(dir).isDirectory()) throw new Error("shared cache path is not a directory")
  }
  return dir
}

/**
 * Resources for a launch. A manifest grant for the thread's repository supplies its engine and cache. Otherwise the
 * first github.com checkout gets an automatic cache scoped to the task owner and that repository.
 */
export const projectResourcesFor = (grants: readonly Grant[], task: { owner: string; checkouts: readonly { repo: string }[] }, dataDir: string) => Effect.try({
  try: () => {
    const matches = grants.filter((grant) => grant.owner === task.owner && task.checkouts.some((checkout) => parseRepoRef(checkout.repo)?.repo === grant.repo))
    if (matches.length > 1) throw new Error("multiple project resource grants match this thread")
    const grant = matches[0]
    if (grant) {
      // Recheck paths at launch so replacing a provisioned path with a symlink fails closed.
      for (const dir of [grant.engineDir, grant.cacheDir]) if (realpathSync(dir) !== dir || !statSync(dir).isDirectory()) throw new Error("project resource directory changed")
      return {
        env: { UE_ENGINE_DIR: ENGINE_TARGET, ...cacheEnv, ...(grant.zenDdcUrl === undefined ? {} : { UE_ZEN_DDC_URL: grant.zenDdcUrl }) },
        binds: [{ host: grant.cacheDir, sandbox: CACHE_TARGET }],
        roTargetBinds: [{ host: grant.engineDir, sandbox: ENGINE_TARGET }],
      }
    }
    const repo = task.checkouts.flatMap((checkout) => parseRepoRef(checkout.repo)?.github ?? [])[0]
    if (!repo) return { env: {}, binds: [], roTargetBinds: [] }
    return {
      env: cacheEnv,
      binds: [{ host: ensureSharedCache(dataDir, task.owner, repo), sandbox: CACHE_TARGET }],
      roTargetBinds: [],
    }
  },
  catch: (error) => new InternalError({ message: `cannot resolve project resources: ${error instanceof Error ? error.message : String(error)}` }),
})

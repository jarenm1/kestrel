import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, normalize, relative } from "node:path"
import { Schema } from "effect"
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

const overlaps = (a: string, b: string): boolean => {
  const r = relative(a, b)
  return r === "" || (!r.startsWith("../") && r !== ".." && !isAbsolute(r))
}
const intersects = (a: string, b: string): boolean => overlaps(a, b) || overlaps(b, a)

/** Load only host-provisioned directories; the operator must keep their ancestors host-controlled. */
export const loadProjectResources = (file: string, dataDir: string): readonly Grant[] => {
  if (!isAbsolute(file)) throw new Error("project resource manifest path must be absolute")
  if (intersects(dataDir, "/kestrel-project-resources")) throw new Error("data directory overlaps project resource targets")
  const grants = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(file, "utf8")), { onExcessProperty: "error" }).grants
  const identities = new Set<string>()
  for (const grant of grants) {
    const ref = parseRepoRef(grant.repo)
    if (!/^[A-Za-z0-9-]+$/.test(grant.owner) || !/^[A-Za-z0-9._-]+$/.test(grant.trustGroup) ||
        ref?.github === null || ref === null || ref.repo !== grant.repo) throw new Error("invalid project resource identity")
    const key = `${grant.owner}\0${grant.repo}`
    if (identities.has(key)) throw new Error("duplicate project resource grant")
    identities.add(key)
    for (const dir of [grant.engineDir, grant.cacheDir]) {
      if (!isAbsolute(dir) || normalize(dir) !== dir || realpathSync(dir) !== dir || !statSync(dir).isDirectory() || intersects(dir, dataDir) ||
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

export const projectResourcesFor = (grants: readonly Grant[], task: { owner: string; checkouts: readonly { repo: string }[] }) => {
  const matches = grants.filter((grant) => grant.owner === task.owner && task.checkouts.some((checkout) => parseRepoRef(checkout.repo)?.repo === grant.repo))
  if (matches.length > 1) throw new Error("multiple project resource grants match this thread")
  const grant = matches[0]
  if (!grant) return { env: {}, binds: [], roTargetBinds: [] }
  // Recheck paths at launch so replacing a provisioned path with a symlink fails closed.
  for (const dir of [grant.engineDir, grant.cacheDir]) if (realpathSync(dir) !== dir || !statSync(dir).isDirectory()) throw new Error("project resource directory changed")
  return {
    env: { UE_ENGINE_DIR: ENGINE_TARGET, ...(grant.zenDdcUrl === undefined ? {} : { UE_ZEN_DDC_URL: grant.zenDdcUrl }) },
    binds: [{ host: grant.cacheDir, sandbox: CACHE_TARGET }],
    roTargetBinds: [{ host: grant.engineDir, sandbox: ENGINE_TARGET }],
  }
}

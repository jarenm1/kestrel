// Builds the single-file kestrel-box binaries into dist/box/.
// Usage: bun scripts/build-box.ts [target...]   (targets: linux-x64 linux-arm64 darwin-x64 darwin-arm64)
import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const readVersion = (pkg: string): string => {
  const json = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")) as { version: string }
  return json.version
}

const serverVersion = readVersion("packages/server")
const npmVersion = readVersion("packages/kestrel-box")
if (serverVersion !== npmVersion) {
  throw new Error(`version mismatch: packages/server is ${serverVersion}, packages/kestrel-box is ${npmVersion}`)
}

const ALL_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
const requested = process.argv.slice(2)
for (const target of requested) {
  if (!ALL_TARGETS.includes(target)) throw new Error(`unknown target ${target}; expected one of ${ALL_TARGETS.join(", ")}`)
}
const targets = requested.length > 0 ? requested : ALL_TARGETS

const outDir = join(root, "dist", "box")
mkdirSync(outDir, { recursive: true })
const entry = join(root, "packages/server/src/cli/main.ts")

for (const target of targets) {
  const [os, arch] = target.split("-")
  const outfile = join(outDir, `kestrel-box-${target}`)
  console.log(`building ${outfile}`)
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", `--target=bun-${os}-${arch}`, entry, `--outfile=${outfile}`],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  )
  if (result.exitCode !== 0) throw new Error(`building ${target} failed with exit code ${result.exitCode}`)
}
console.log(`built ${targets.length} target(s) in ${outDir}`)

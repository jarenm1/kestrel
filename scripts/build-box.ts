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

/**
 * Bun targets per asset. linux-x64 is the `baseline` build: when the target matches the host, `bun build --compile`
 * reuses the running bun, and on NixOS that one loads through /nix/store, so the binary would not start anywhere else.
 * Baseline is always downloaded and also runs on CPUs without AVX2 (older machines, some VMs).
 */
const BUN_TARGETS: Record<string, string> = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
}

/** The ELF program interpreter (PT_INTERP) of a 64-bit little-endian binary. */
const elfInterpreter = (file: string): string | null => {
  const bytes = readFileSync(file)
  const phoff = Number(bytes.readBigUInt64LE(0x20))
  const phentsize = bytes.readUInt16LE(0x36)
  for (let i = 0; i < bytes.readUInt16LE(0x38); i++) {
    const header = phoff + i * phentsize
    if (bytes.readUInt32LE(header) !== 3) continue
    const offset = Number(bytes.readBigUInt64LE(header + 0x08))
    const size = Number(bytes.readBigUInt64LE(header + 0x20))
    return bytes.subarray(offset, offset + size).toString("utf8").replace(/\0+$/, "")
  }
  return null
}

for (const target of targets) {
  const outfile = join(outDir, `kestrel-box-${target}`)
  console.log(`building ${outfile}`)
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", `--target=${BUN_TARGETS[target]}`, entry, `--outfile=${outfile}`],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  )
  if (result.exitCode !== 0) throw new Error(`building ${target} failed with exit code ${result.exitCode}`)
  if (target.startsWith("linux-")) {
    const interpreter = elfInterpreter(outfile)
    if (interpreter === null || !interpreter.startsWith("/lib")) {
      throw new Error(`${outfile} loads through ${interpreter ?? "no interpreter"}; it would not start on other distributions`)
    }
  }
}
console.log(`built ${targets.length} target(s) in ${outDir}`)

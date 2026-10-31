import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) {
  console.error("Usage: bun scripts/managed-box-keys.ts <private-output-directory>")
  process.exit(1)
}
const target = resolve(directory)
mkdirSync(target, { recursive: true, mode: 0o700 })
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey)
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey)
// Refuse to overwrite a deployed key. Private key material never goes to stdout or the repository.
writeFileSync(join(target, "managed-private.jwk"), JSON.stringify(privateKey) + "\n", { mode: 0o600, flag: "wx" })
writeFileSync(join(target, "managed-public.jwk"), JSON.stringify(publicKey) + "\n", { mode: 0o600, flag: "wx" })
console.log(`Managed signing keys written to ${target}; upload only managed-private.jwk to the Worker.`)

import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { TEMPLATE_BOOT_MEMORY_BYTES } from "./ch-api"
import { HostError, errorMessage } from "./errors"
import { STRICT } from "./schema"

const NonNeg = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const Positive = Schema.Number.pipe(Schema.int(), Schema.positive())

const GpuConfig = Schema.Struct({
  pciAddress: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/)),
  model: Schema.String.pipe(Schema.minLength(1)),
  vramBytes: NonNeg,
})

/**
 * `/etc/kestrel-host/config.json`. Every path is absolute. Durations are milliseconds. The host secret is read from
 * `hostSecretFile` at start; it is never part of this file.
 */
export const HostConfig = Schema.Struct({
  hostId: Schema.String.pipe(Schema.minLength(1)),
  slug: Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,63}$/)),
  /** Control plane WebSocket base, e.g. `wss://api.example.com`. */
  controlUrl: Schema.String.pipe(Schema.minLength(1)),
  hostSecretFile: Schema.String.pipe(Schema.minLength(1)),
  /** Control plane origin for meter batches, e.g. `https://api.example.com`. */
  meterUrl: Schema.String.pipe(Schema.minLength(1)),
  stateDir: Schema.String.pipe(Schema.minLength(1)),
  runDir: Schema.String.pipe(Schema.minLength(1)),
  nestDomain: Schema.String.pipe(Schema.minLength(1)),
  agentVersion: Schema.String.pipe(Schema.minLength(1)),
  cloudHypervisor: Schema.String.pipe(Schema.minLength(1)),
  volumeTool: Schema.String.pipe(Schema.minLength(1)),
  /** Guest image directory: contains `manifest.json`. */
  guestImageDir: Schema.String.pipe(Schema.minLength(1)),
  /** `file:///dir` or `s3://bucket/prefix` for `kestrel-volume`. */
  volumeStore: Schema.String.pipe(Schema.minLength(1)),
  /** Fleet key for `kestrel-volume --key-file`; omitted when the store is unencrypted. */
  volumeKeyFile: Schema.NullOr(Schema.String),
  /** `systemd` runs each VMM in a transient scope under `kestrel-vms.slice`; `none` runs it directly (smoke tests). */
  scope: Schema.Literal("systemd-system", "systemd-user", "none"),
  template: Schema.Struct({
    maxVcpus: Positive,
    maxMemoryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThan(TEMPLATE_BOOT_MEMORY_BYTES)),
  }),
  capacity: Schema.Struct({
    vcpus: Positive,
    memoryBytes: Positive,
  }),
  gpus: Schema.Array(GpuConfig),
  egressMbit: Positive,
  idleSuspendAfterMs: Positive,
  parkAfterMs: Positive,
  backupIntervalMs: Positive,
  meterIntervalMs: Positive,
  depcacheUrl: Schema.NullOr(Schema.String),
  nixCacheUrl: Schema.NullOr(Schema.String),
  nixCachePublicKey: Schema.NullOr(Schema.String),
})
export type HostConfig = typeof HostConfig.Type

/** Reads and validates the config file. Throws HostError with the first problem found. */
export const loadConfig = (path: string): HostConfig => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new HostError(`cannot read config ${path}: ${errorMessage(error)}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new HostError(`config ${path} is not JSON: ${errorMessage(error)}`)
  }
  const decoded = Schema.decodeUnknownEither(HostConfig, STRICT)(json)
  if (decoded._tag === "Left") throw new HostError(`invalid config ${path}: ${String(decoded.left)}`)
  return decoded.right
}

/** Reads the host secret. Trimmed; never logged. */
export const readHostSecret = (path: string): string => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    throw new HostError(`cannot read host secret ${path}: ${errorMessage(error)}`)
  }
  const secret = text.trim()
  if (secret === "") throw new HostError(`host secret ${path} is empty`)
  return secret
}

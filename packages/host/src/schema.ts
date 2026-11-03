import { Schema } from "effect"

/** RFC 4122 version 4 (random) UUID, lowercase as produced by `crypto.randomUUID`. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const Uuid = Schema.String.pipe(Schema.pattern(UUID_V4, { message: () => "must be a UUID v4" }))

/** Non-empty after trimming, with no control characters. Used for user identifiers. */
export const Identifier = Schema.String.pipe(
  Schema.pattern(/^[^\u0000-\u001f\u007f]*[^\s\u0000-\u001f\u007f][^\u0000-\u001f\u007f]*$/, {
    message: () => "must be a non-empty identifier without control characters",
  }),
  Schema.maxLength(256),
)

/** UTC instant with millisecond precision, exactly as `Date.prototype.toISOString` writes it. */
export const IsoMillis = Schema.String.pipe(
  Schema.pattern(ISO_MS, { message: () => "must be a UTC ISO timestamp with milliseconds" }),
  Schema.filter((value) => new Date(value).toISOString() === value || "is not a valid instant"),
)

export const AbsolutePath = Schema.String.pipe(
  Schema.pattern(/^\//, { message: () => "must be an absolute path" }),
)

/** Process identity: `startTime` is /proc/<pid>/stat field 22 (clock ticks), so a reused pid does not match. */
export const ProcessRef = Schema.Struct({
  pid: Schema.Int.pipe(Schema.positive()),
  startTime: Schema.Int.pipe(Schema.nonNegative()),
  name: Identifier,
})
export type ProcessRef = typeof ProcessRef.Type

export const VmState = Schema.Literal("stopped", "starting", "running", "stopping", "destroying", "deleted")
export type VmState = typeof VmState.Type

export const Shape = Schema.Struct({
  cpus: Schema.Int.pipe(Schema.between(1, 8)),
  memoryMb: Schema.Int.pipe(Schema.between(128, 4096)),
})
export type Shape = typeof Shape.Type

export const VolumeIdentity = Schema.Struct({
  label: Schema.Literal("kestrel-data"),
  uuid: Uuid,
})
export type VolumeIdentity = typeof VolumeIdentity.Type

/** `vms/<vmId>/vm.json`. A deleted VM keeps this record as its tombstone; its disks and sockets are removed. */
export const VmRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  vmId: Uuid,
  userId: Identifier,
  hostId: Uuid,
  shape: Shape,
  state: VmState,
  sequence: Schema.Int.pipe(Schema.nonNegative()),
  osDisk: AbsolutePath,
  dataDisk: AbsolutePath,
  volume: VolumeIdentity,
  process: Schema.NullOr(ProcessRef),
  createdAt: IsoMillis,
  updatedAt: IsoMillis,
  /** True while a `running` lifecycle record is open, i.e. no `parked` record has closed it yet. */
  runningReported: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
})
export type VmRecord = typeof VmRecord.Type

/** `host.json`, created once per state directory. */
export const HostRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hostId: Uuid,
})
export type HostRecord = typeof HostRecord.Type

/** Strict decode: unknown keys are errors, not silently dropped. */
export const STRICT: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" }

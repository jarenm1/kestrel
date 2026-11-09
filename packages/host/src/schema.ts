import { Schema } from "effect"
import { NestLimits, NestVmState, NestVolumeRef } from "@cloudagents/protocol"

/** RFC 4122 version 4 (random) UUID, lowercase as produced by `crypto.randomUUID`. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const Uuid = Schema.String.pipe(Schema.pattern(UUID_V4, { message: () => "must be a UUID v4" }))

/** Non-empty after trimming, with no control characters. */
export const Identifier = Schema.String.pipe(
  Schema.pattern(/^[^\u0000-\u001f\u007f]*[^\s\u0000-\u001f\u007f][^\u0000-\u001f\u007f]*$/, {
    message: () => "must be a non-empty identifier without control characters",
  }),
  Schema.maxLength(256),
)

const NonNeg = Schema.Number.pipe(Schema.int(), Schema.nonNegative())

/** Process identity: `startTime` is /proc/<pid>/stat field 22 (clock ticks), so a reused pid does not match. */
export const ProcessRef = Schema.Struct({
  pid: Schema.Int.pipe(Schema.positive()),
  startTime: Schema.Int.pipe(Schema.nonNegative()),
  name: Identifier,
})
export type ProcessRef = typeof ProcessRef.Type

/** The host-side network of a VM: its tap, guest address and vsock context id, all derived from one slot. */
export const NestNetwork = Schema.Struct({
  slot: NonNeg,
  address: Schema.String,
  cid: NonNeg,
  tap: Schema.String,
})
export type NestNetwork = typeof NestNetwork.Type

/** `kestrel-volume restore-lazy` serving the volume as a block device until it is stopped. */
export const VolumeProcess = Schema.Struct({
  process: ProcessRef,
  device: Schema.String,
})
export type VolumeProcess = typeof VolumeProcess.Type

/**
 * The state-changing operation in flight. Written before the first side effect and cleared after the last one, so a
 * restarted agent knows what to roll back (see `recovery.ts`).
 */
export const Operation = Schema.Struct({
  kind: Schema.Literal("create", "resume", "suspend", "park", "destroy", "gpuAttach", "gpuDetach"),
  /** For `resume`: the state the VM was in before. */
  from: Schema.NullOr(Schema.Literal("suspended", "parked")),
  startedAt: NonNeg,
})
export type Operation = typeof Operation.Type

/** `vms/<boxId>/vm.json`. A destroyed VM keeps this record as its tombstone (state `deleted`). */
export const VmRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  boxId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  vmId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  userId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  ownerEpoch: NonNeg,
  state: NestVmState,
  since: NonNeg,
  /** The guest image the VM was cloned from. */
  imageId: Schema.String,
  publicUrl: Schema.String,
  limits: NestLimits,
  vcpus: NonNeg,
  memoryBytes: NonNeg,
  /** PCI addresses of attached GPUs. */
  gpus: Schema.Array(Schema.String),
  gpuAttachedAt: Schema.NullOr(NonNeg),
  /** The latest completed backup in object storage. */
  volumeRef: Schema.NullOr(NestVolumeRef),
  backedUpAt: Schema.NullOr(NonNeg),
  /** The backup the local volume file equals, or null once the VM has run since. */
  localRef: Schema.NullOr(NestVolumeRef),
  /** True while the local volume may hold data no backup covers: it is then the only authoritative copy. */
  localDirty: Schema.Boolean,
  /**
   * True from before the host sends `prepareSuspend` or `freezeVolume` until it ends the freeze with `thawVolume`, or
   * stops the VM. Recorded first, so a restart that finds it stops the VM rather than trusting the guest's state.
   */
  frozen: Schema.Boolean,
  network: Schema.NullOr(NestNetwork),
  process: Schema.NullOr(ProcessRef),
  volumeProcess: Schema.NullOr(VolumeProcess),
  /** Generation of the memory image under `snapshot.<gen>/`, or null when there is none. */
  snapshotGen: Schema.NullOr(NonNeg),
  /** The clone id the running guest was configured with; a resent `create` reconfigures that guest with it. */
  cloneId: Schema.NullOr(Schema.String),
  /**
   * Why a `deleted` record is a tombstone. `evict` leaves the backup for the box's new owner, so no `destroy` may wipe
   * it; absent (records written before this field) means a destroy, whose wipe a resent command may finish. `evict`
   * writes this before it releases the VM, so a crash mid-evict recovers with the cause intact.
   */
  tombstone: Schema.optional(Schema.NullOr(Schema.Literal("destroy", "evict"))),
  operation: Schema.NullOr(Operation),
  lastError: Schema.NullOr(Schema.String),
})
export type VmRecord = typeof VmRecord.Type

/** The outcome of a command, kept so a resent command (same commandId) gets the same answer. */
export const CommandOutcome = Schema.Struct({
  commandId: Schema.String,
  boxId: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  /** False until the outcome has been written to the control plane (on a `result` or in `hello`). */
  reported: Schema.Boolean,
})
export type CommandOutcome = typeof CommandOutcome.Type

/** Strict decode: unknown keys are errors, not silently dropped. */
export const STRICT: { readonly onExcessProperty: "error" } = { onExcessProperty: "error" }

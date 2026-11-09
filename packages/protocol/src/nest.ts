/**
 * The Nest: Kestrel's per-user VMs. This module is the contract between a Nest host agent (`packages/host`) and the
 * control plane (`packages/control`), plus the Nest fields the apps see. The design is in `docs/nest.md`.
 *
 * A Nest box is an ordinary single-owner box (a `UserBox` row with its own secret) that runs in a VM on a Nest host.
 * The host agent dials the control plane over one WebSocket (`ControlPaths.nestHostConnect`), reports capacity and VM
 * state, and executes the control plane's commands. The host never sees the box secret: a new box enrolls itself with a
 * one-time token (`ControlPaths.nestEnroll`).
 */
import { Schema } from "effect"

/** A Nest box or host name: the same rule as `BoxName` in `control.ts`, which imports this module. */
const NestName = Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(64))

/** Version of the host link frames below. A host speaking another version is refused at `hello`. */
export const NEST_HOST_PROTOCOL = 1

/** Header naming the host on `ControlPaths.nestHostConnect`, with `Authorization: Bearer <host secret>`. */
export const NEST_HOST_ID_HEADER = "x-kestrel-nest-host"

/** Largest host link frame either side sends or accepts. */
export const MAX_NEST_FRAME_BYTES = 256 * 1024

/** A host sends `capacity` at least this often while connected (and on every change in between). */
export const NEST_CAPACITY_INTERVAL_MS = 60_000

/** An enrollment token is accepted for this long after the control plane issued (or reissued) it. */
export const NEST_ENROLL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/** Smallest memory a VM may be limited to: the template boots with 1 GiB and the resource policy never goes below it. */
export const NEST_MIN_MEMORY_BYTES = 1024 ** 3
/** Smallest and largest volume a box may ask for. Volumes are sparse, so the largest bounds what one box can claim. */
export const NEST_MIN_VOLUME_BYTES = 1024 ** 3
export const NEST_MAX_VOLUME_BYTES = 1024 ** 4
/** Longest `error` a host link frame carries; the sender cuts a longer one. */
export const NEST_ERROR_MAX_CHARS = 1000
/** Most GPUs one host reports, and most VMs in one `inventory` frame (keeps every frame under `MAX_NEST_FRAME_BYTES`). */
export const NEST_MAX_GPUS = 16
export const NEST_INVENTORY_CHUNK_VMS = 50
/** Intended slack after a host's last lease before control moves that host's boxes (covers clock skew). Not enforced yet: no placement code reads it (see docs/nest.md). */
export const NEST_FENCE_MARGIN_MS = 60_000
/**
 * The `error` of a command a host refused because its lease had lapsed: it did not run, so the control plane may send it
 * again once the lease is renewed.
 */
export const NEST_LAPSE_REFUSAL = "control lease lapsed before the command ran"
/** An enrollment token: 32 random bytes, base64url (the same form as every box secret). */
export const NestEnrollToken = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/))
/** A PCI address, e.g. `0000:01:00.0`. */
const PciAddress = Schema.String.pipe(Schema.maxLength(32))

/**
 * - `provisioning`: the host is creating the VM (template clone, volume, first configure).
 * - `running`: the VM holds CPU and memory (and any GPU).
 * - `suspended`: memory is saved on the host's local disk; resume is fast and only on that host.
 * - `parked`: only the volume is kept, locally and/or in object storage; resume is a template clone on any host.
 * - `deleted`: the volume is wiped. Terminal.
 */
export const NestVmState = Schema.Literal("provisioning", "running", "suspended", "parked", "deleted")
export type NestVmState = typeof NestVmState.Type

/** Whether the VM may borrow a GPU. A GPU is a device the VM attaches while needed, never a VM type. */
export const NestGpuPolicy = Schema.Literal("none", "on-demand")
export type NestGpuPolicy = typeof NestGpuPolicy.Type

const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.positive())
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const Bytes = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const Id = Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(200))
/** Milliseconds since the Unix epoch. */
const EpochMs = Schema.Number.pipe(Schema.int(), Schema.nonNegative())

/**
 * The most a VM may use. The host's policy sizes the running VM inside these limits from the guest's measured pressure:
 * vCPUs are hot-added and removed, memory is plugged and unplugged with virtio-mem. A shape is a set of limits.
 */
export const NestLimits = Schema.Struct({
  maxVcpus: PositiveInt,
  maxMemoryBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(NEST_MIN_MEMORY_BYTES)),
  gpu: NestGpuPolicy,
  /** Size of the volume the guest sees, from 1 GiB to 1 TiB. Only allocated blocks use host disk. */
  volumeBytes: Schema.Number.pipe(Schema.int(), Schema.between(NEST_MIN_VOLUME_BYTES, NEST_MAX_VOLUME_BYTES)),
})
export type NestLimits = typeof NestLimits.Type

/** Where a parked volume's latest backup lives in object storage: an opaque manifest reference the host returned. */
export const NestVolumeRef = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024))
export type NestVolumeRef = typeof NestVolumeRef.Type

/**
 * Which placement of a box is current. The control plane raises it every time it places the box (create, and resume
 * from parked on any host). A host acts only on its highest epoch for a box, and evicts a local copy whose epoch is
 * lower than one the control plane names, so two hosts never run the same box.
 */
const OwnerEpoch = NonNegativeInt

/** One VM as its host reports it. */
export const NestVmReport = Schema.Struct({
  boxId: Id,
  /** The VM incarnation; the same id that usage records carry. A VM cloned again after parking gets a new one. */
  vmId: Id,
  userId: Id,
  ownerEpoch: OwnerEpoch,
  state: NestVmState,
  /**
   * When the VM entered `state`, by the host's clock. Never decreases for one VM on one host, even if the clock steps
   * back (the host then reports 1 ms past the previous state's): control drops a report older than the last it applied.
   */
  since: EpochMs,
  /** The guest image this VM was cloned from (`manifest.json` `imageId`). */
  imageId: Id,
  /** vCPUs and memory currently given to the guest; 0 unless running. */
  vcpus: NonNegativeInt,
  memoryBytes: Bytes,
  /** PCI addresses of the GPUs attached now. */
  gpus: Schema.Array(PciAddress).pipe(Schema.maxItems(NEST_MAX_GPUS)),
  /** Host disk the volume uses (allocated blocks), plus the saved memory image while suspended. */
  diskBytes: Bytes,
  /**
   * The latest completed backup, when there is one. The host's local volume equals this backup only while the VM has
   * not run since; a resume names the backup it expects, and the host uses its local copy only when they match.
   */
  volumeRef: Schema.NullOr(NestVolumeRef),
  /** When `volumeRef` was taken. Running VMs are backed up periodically, not only at park. */
  backedUpAt: Schema.NullOr(EpochMs),
  limits: NestLimits,
})
export type NestVmReport = typeof NestVmReport.Type

export const NestHostGpu = Schema.Struct({
  /** PCI address, e.g. `0000:01:00.0`. */
  pciAddress: PciAddress,
  model: Schema.String.pipe(Schema.maxLength(200)),
  vramBytes: Bytes,
  /** The box holding it, or null when free. */
  attachedTo: Schema.NullOr(Id),
})
export type NestHostGpu = typeof NestHostGpu.Type

/** What the host can still place. The control plane places by these numbers alone. */
export const NestHostCapacity = Schema.Struct({
  /** Logical CPUs the host gives to VMs, and vCPUs currently plugged into running VMs (CPU may be overcommitted). */
  vcpus: NonNegativeInt,
  vcpusPlugged: NonNegativeInt,
  /** Memory the host gives to VMs, and memory currently plugged into running VMs. */
  memoryBytes: Bytes,
  memoryPluggedBytes: Bytes,
  /** Free space for volumes and memory images, after `diskReservedBytes`. */
  diskFreeBytes: Bytes,
  /** Space held back so every running VM can still be suspended (its plugged memory) and every lazy volume finished. */
  diskReservedBytes: Bytes,
  gpus: Schema.Array(NestHostGpu).pipe(Schema.maxItems(NEST_MAX_GPUS)),
  running: NonNegativeInt,
  suspended: NonNegativeInt,
})
export type NestHostCapacity = typeof NestHostCapacity.Type

/**
 * Commands the control plane sends a host. The host deduplicates by `commandId` (a resent command gets the stored
 * result) and runs commands and its own policy actions for one box one at a time. Every box command carries the box's
 * current `ownerEpoch`. A command with an epoch lower than the host holds is refused. So is a command for a box the host
 * holds no record of, except `create` and `resume`, which create the record at the epoch they carry (a `resume` with a
 * higher epoch replaces the record; the control plane sends it only after the old host is fenced or evicted).
 */
export const NestHostCommand = Schema.Union(
  /**
   * Create a new box's VM with an empty volume. The guest enrolls with `enrollToken` to get its secret. A resent
   * `create` may carry a fresh token; the host passes the newest one on while the box has not enrolled.
   */
  Schema.Struct({
    _tag: Schema.Literal("create"),
    boxId: Id,
    userId: Id,
    vmId: Id,
    ownerEpoch: OwnerEpoch,
    limits: NestLimits,
    /** The box's public origin, `https://<boxId>.<host slug>.<nest domain>`. */
    publicUrl: Schema.String.pipe(Schema.maxLength(2048)),
    enrollToken: NestEnrollToken,
  }),
  /**
   * Bring a box to `running`. From `suspended` (on this host, same epoch): restore its memory image. From `parked`:
   * clone the template and attach the volume: the local copy only when its backup equals `volumeRef` (or both are
   * null and this host created it), otherwise lazily from `volumeRef`; the clone gets the new `vmId`. `enrollToken` is
   * the box's newest token while it has not enrolled, null otherwise.
   */
  Schema.Struct({
    _tag: Schema.Literal("resume"),
    boxId: Id,
    userId: Id,
    vmId: Id,
    ownerEpoch: OwnerEpoch,
    limits: NestLimits,
    publicUrl: Schema.String,
    volumeRef: Schema.NullOr(NestVolumeRef),
    enrollToken: Schema.NullOr(NestEnrollToken),
  }),
  Schema.Struct({ _tag: Schema.Literal("suspend"), boxId: Id, ownerEpoch: OwnerEpoch }),
  /**
   * Quiesce and sync a running VM as for suspend (a failed or timed-out quiesce aborts the park), then back up the volume
   * to object storage and release everything but (optionally cached) disk.
   */
  Schema.Struct({ _tag: Schema.Literal("park"), boxId: Id, ownerEpoch: OwnerEpoch }),
  /** Change the limits of a box in any state; a running VM is resized at once when it is above them. */
  Schema.Struct({ _tag: Schema.Literal("setLimits"), boxId: Id, ownerEpoch: OwnerEpoch, limits: NestLimits }),
  Schema.Struct({ _tag: Schema.Literal("gpuAttach"), boxId: Id, ownerEpoch: OwnerEpoch }),
  Schema.Struct({ _tag: Schema.Literal("gpuDetach"), boxId: Id, ownerEpoch: OwnerEpoch }),
  /** Stop the VM, wipe the volume and its backups, and report `deleted`. */
  Schema.Struct({ _tag: Schema.Literal("destroy"), boxId: Id, ownerEpoch: OwnerEpoch }),
  /**
   * The box lives elsewhere now (epoch above `ownerEpoch` held here): drop the local VM, memory image and volume,
   * keep the backups, and stop reporting it. Sent at `hello` for every VM the host reports that it no longer owns.
   */
  Schema.Struct({ _tag: Schema.Literal("evict"), boxId: Id, ownerEpoch: OwnerEpoch }),
)
export type NestHostCommand = typeof NestHostCommand.Type

/** Frames a host sends on `ControlPaths.nestHostConnect`. */
export const NestHostFrame = Schema.Union(
  /**
   * First frame on every connection: the host's identity and capacity. The control plane answers with `lease`. Then the
   * host sends `result` frames for commands that finished while disconnected, and its VMs as `inventory` chunks.
   */
  Schema.Struct({
    _tag: Schema.Literal("hello"),
    /** Compared after decoding, so a mismatch can be answered with `refused`. */
    protocol: Schema.Number.pipe(Schema.int()),
    hostId: Id,
    agentVersion: Schema.String.pipe(Schema.maxLength(100)),
    /** DNS label under the Nest domain that routes to this host's ingress. */
    slug: Schema.String.pipe(Schema.pattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
    /** The guest image new VMs on this host are cloned from. */
    imageId: Id,
    capacity: NestHostCapacity,
  }),
  /**
   * The host's VMs after `hello`, in chunks of at most `NEST_INVENTORY_CHUNK_VMS`. `last` is true on the final chunk,
   * which may be empty. The control plane evicts stale copies only once it has the last chunk.
   */
  Schema.Struct({
    _tag: Schema.Literal("inventory"),
    vms: Schema.Array(NestVmReport).pipe(Schema.maxItems(NEST_INVENTORY_CHUNK_VMS)),
    last: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("capacity"), capacity: NestHostCapacity }),
  /** A VM changed state, size or GPUs, on a command or by the host's own policy (idle suspend, resize). */
  Schema.Struct({ _tag: Schema.Literal("vm"), vm: NestVmReport }),
  /** The outcome of `command`; `vm` is the VM after it, absent once destroyed. */
  Schema.Struct({
    _tag: Schema.Literal("result"),
    commandId: Id,
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String.pipe(Schema.maxLength(NEST_ERROR_MAX_CHARS))),
    vm: Schema.optional(NestVmReport),
  }),
  /**
   * A request reached ingress for a box this host may not wake by itself (parked, or suspended without a valid lease).
   * The control plane answers with `resume` (to this host or, for a parked box, possibly another) or ignores it.
   */
  Schema.Struct({ _tag: Schema.Literal("wakeRequest"), boxId: Id }),
)
export type NestHostFrame = typeof NestHostFrame.Type

/** Frames the control plane sends a host. */
export const NestControlFrame = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("command"), commandId: Id, command: NestHostCommand }),
  /**
   * Sent after `hello` and every `capacity`. Until `validUntil` the host may wake a box it holds as `suspended` on an
   * ingress request without asking, and keeps its running VMs. Past it (control plane unreachable) the host fences:
   * it stops every running VM at once without a sync, wakes nothing, and resumes a `parked` box only on a `resume`
   * command. The control plane is meant to move a box off a host it cannot reach only after that host's last
   * `validUntil` plus `NEST_FENCE_MARGIN_MS`, but no placement code enforces this yet, and control does not move a box
   * a host still claims (see docs/nest.md).
   */
  Schema.Struct({ _tag: Schema.Literal("lease"), validUntil: EpochMs }),
  /** Refusal of the connection (unknown host, protocol mismatch); the socket closes after it. */
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: Schema.String.pipe(Schema.maxLength(NEST_ERROR_MAX_CHARS)) }),
)
export type NestControlFrame = typeof NestControlFrame.Type

/** How long a `lease` lasts; the control plane sends one at least every `NEST_CAPACITY_INTERVAL_MS`. */
export const NEST_LEASE_MS = 5 * 60_000

/** `POST ControlPaths.nestEnroll` body, sent by a new box from inside its VM. */
export const NestEnrollBody = Schema.Struct({ boxId: Id, token: NestEnrollToken })
export type NestEnrollBody = typeof NestEnrollBody.Type

/**
 * The box's own secret. Enrollment is idempotent: the same token returns the same secret until the box first
 * authenticates with it (`ControlPaths.boxSelf`), so a box that crashed before saving it can enroll again. After that,
 * or once the token expires, it is refused.
 */
export const NestEnrollResult = Schema.Struct({ secret: Schema.String })
export type NestEnrollResult = typeof NestEnrollResult.Type

/** A Nest box's VM as the apps see it, on `UserBox.nest`. */
export const NestBoxStatus = Schema.Struct({
  state: NestVmState,
  /** The create never produced a VM (it failed or timed out). The box has no VM; the owner can delete it. */
  failed: Schema.Boolean,
  /** A command is in flight (resume, suspend, park, resize, GPU): the apps show it as pending. */
  pending: Schema.NullOr(Schema.Literal("resume", "suspend", "park", "setLimits", "gpuAttach", "gpuDetach", "destroy")),
  limits: NestLimits,
  vcpus: NonNegativeInt,
  memoryBytes: Bytes,
  gpus: NonNegativeInt,
})
export type NestBoxStatus = typeof NestBoxStatus.Type

/** `POST ControlPaths.nestBoxes`: create a Nest box for the signed-in user. Limits default to the standard shape. */
export const CreateNestBoxBody = Schema.Struct({ name: NestName, limits: Schema.optional(NestLimits) })
export type CreateNestBoxBody = typeof CreateNestBoxBody.Type

/** A Nest host as operators see it (Settings › Fleet). */
export const NestHostStatus = Schema.Struct({
  id: Schema.String,
  name: NestName,
  slug: Schema.NullOr(Schema.String),
  connected: Schema.Boolean,
  agentVersion: Schema.NullOr(Schema.String),
  capacity: Schema.NullOr(NestHostCapacity),
  lastSeenAt: Schema.NullOr(Schema.String),
})
export type NestHostStatus = typeof NestHostStatus.Type

export const NestHostList = Schema.Struct({ hosts: Schema.Array(NestHostStatus) })
export type NestHostList = typeof NestHostList.Type

export const decodeNestHostFrame = Schema.decodeUnknownEither(Schema.parseJson(NestHostFrame))
export const decodeNestControlFrame = Schema.decodeUnknownEither(Schema.parseJson(NestControlFrame))

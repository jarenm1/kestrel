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
import { BoxName, UserBox } from "./control"

/** Version of the host link frames below. A host speaking another version is refused at `hello`. */
export const NEST_HOST_PROTOCOL = 1

/** Header naming the host on `ControlPaths.nestHostConnect`, with `Authorization: Bearer <host secret>`. */
export const NEST_HOST_ID_HEADER = "x-kestrel-nest-host"

/** Largest host link frame either side sends or accepts. */
export const MAX_NEST_FRAME_BYTES = 256 * 1024

/** A host sends `capacity` at least this often while connected (and on every change in between). */
export const NEST_CAPACITY_INTERVAL_MS = 60_000

/** An enrollment token is accepted for this long after the control plane issued it. */
export const NEST_ENROLL_TOKEN_TTL_MS = 60 * 60 * 1000

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
  maxMemoryBytes: Bytes,
  gpu: NestGpuPolicy,
  /** Size of the volume the guest sees. Only allocated blocks use host disk. */
  volumeBytes: Bytes,
})
export type NestLimits = typeof NestLimits.Type

/** Where a parked volume's latest backup lives in object storage: an opaque manifest reference the host returned. */
export const NestVolumeRef = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024))
export type NestVolumeRef = typeof NestVolumeRef.Type

/** One VM as its host reports it. */
export const NestVmReport = Schema.Struct({
  boxId: Id,
  /** The VM incarnation; the same id that usage records carry. A VM cloned again after parking gets a new one. */
  vmId: Id,
  userId: Id,
  state: NestVmState,
  /** When the VM entered `state`. */
  since: EpochMs,
  /** vCPUs and memory currently given to the guest; 0 unless running. */
  vcpus: NonNegativeInt,
  memoryBytes: Bytes,
  /** PCI addresses of the GPUs attached now. */
  gpus: Schema.Array(Schema.String),
  /** Host disk the volume uses (allocated blocks), plus the saved memory image while suspended. */
  diskBytes: Bytes,
  /** The latest completed backup, when there is one. */
  volumeRef: Schema.NullOr(NestVolumeRef),
  limits: NestLimits,
})
export type NestVmReport = typeof NestVmReport.Type

export const NestHostGpu = Schema.Struct({
  /** PCI address, e.g. `0000:01:00.0`. */
  pciAddress: Schema.String,
  model: Schema.String,
  vramBytes: Bytes,
  /** The box holding it, or null when free. */
  attachedTo: Schema.NullOr(Schema.String),
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
  /** Free space for volumes and memory images. */
  diskFreeBytes: Bytes,
  gpus: Schema.Array(NestHostGpu),
  running: NonNegativeInt,
  suspended: NonNegativeInt,
})
export type NestHostCapacity = typeof NestHostCapacity.Type

/** Commands the control plane sends a host. Each is idempotent per `boxId`: a retry of a finished command succeeds. */
export const NestHostCommand = Schema.Union(
  /** Create a new box's VM with an empty volume. The guest enrolls with `enrollToken` to get its secret. */
  Schema.Struct({
    _tag: Schema.Literal("create"),
    boxId: Id,
    userId: Id,
    vmId: Id,
    limits: NestLimits,
    /** The box's public origin, `https://<boxId>.<host slug>.<nest domain>`. */
    publicUrl: Schema.String,
    enrollToken: Schema.String,
  }),
  /**
   * Bring a box to `running`. From `suspended`: restore its memory image. From `parked`: clone the template and attach
   * the volume, from local disk or, when the host does not have it, lazily from `volumeRef` (with a new `vmId`).
   */
  Schema.Struct({
    _tag: Schema.Literal("resume"),
    boxId: Id,
    userId: Id,
    vmId: Id,
    limits: NestLimits,
    publicUrl: Schema.String,
    volumeRef: Schema.NullOr(NestVolumeRef),
  }),
  Schema.Struct({ _tag: Schema.Literal("suspend"), boxId: Id }),
  /** Back up the volume to object storage and release everything but (optionally cached) disk. */
  Schema.Struct({ _tag: Schema.Literal("park"), boxId: Id }),
  /** Change the limits of a box in any state; a running VM is resized at once when it is above them. */
  Schema.Struct({ _tag: Schema.Literal("setLimits"), boxId: Id, limits: NestLimits }),
  Schema.Struct({ _tag: Schema.Literal("gpuAttach"), boxId: Id }),
  Schema.Struct({ _tag: Schema.Literal("gpuDetach"), boxId: Id }),
  /** Stop the VM, wipe the volume and its backups, and report `deleted`. */
  Schema.Struct({ _tag: Schema.Literal("destroy"), boxId: Id }),
)
export type NestHostCommand = typeof NestHostCommand.Type

/** Frames a host sends on `ControlPaths.nestHostConnect`. */
export const NestHostFrame = Schema.Union(
  /** First frame on every connection: the full state, which the control plane reconciles against its records. */
  Schema.Struct({
    _tag: Schema.Literal("hello"),
    protocol: Schema.Literal(NEST_HOST_PROTOCOL),
    hostId: Id,
    agentVersion: Schema.String,
    /** DNS label under the Nest domain that routes to this host's ingress. */
    slug: Schema.String.pipe(Schema.pattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
    capacity: NestHostCapacity,
    vms: Schema.Array(NestVmReport),
  }),
  Schema.Struct({ _tag: Schema.Literal("capacity"), capacity: NestHostCapacity }),
  /** A VM changed state, size or GPUs, on a command or by the host's own policy (idle suspend, resize). */
  Schema.Struct({ _tag: Schema.Literal("vm"), vm: NestVmReport }),
  /** The outcome of `command`; `vm` is the VM after it, absent once destroyed. */
  Schema.Struct({
    _tag: Schema.Literal("result"),
    commandId: Id,
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String),
    vm: Schema.optional(NestVmReport),
  }),
)
export type NestHostFrame = typeof NestHostFrame.Type

/** Frames the control plane sends a host. */
export const NestControlFrame = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("command"), commandId: Id, command: NestHostCommand }),
  /** Refusal of the connection (unknown host, protocol mismatch); the socket closes after it. */
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: Schema.String }),
)
export type NestControlFrame = typeof NestControlFrame.Type

/** `POST ControlPaths.nestEnroll` body, sent by a new box from inside its VM. */
export const NestEnrollBody = Schema.Struct({ boxId: Id, token: Schema.String.pipe(Schema.minLength(1)) })
export type NestEnrollBody = typeof NestEnrollBody.Type

/** The box's own secret. The token is spent; a second enrollment with it is refused. */
export const NestEnrollResult = Schema.Struct({ secret: Schema.String })
export type NestEnrollResult = typeof NestEnrollResult.Type

/** A Nest box's VM as the apps see it, on `UserBox.nest`. */
export const NestBoxStatus = Schema.Struct({
  state: NestVmState,
  /** A command is in flight (resume, suspend, park, resize, GPU): the apps show it as pending. */
  pending: Schema.NullOr(Schema.Literal("resume", "suspend", "park", "setLimits", "gpuAttach", "gpuDetach", "destroy")),
  limits: NestLimits,
  vcpus: NonNegativeInt,
  memoryBytes: Bytes,
  gpus: NonNegativeInt,
})
export type NestBoxStatus = typeof NestBoxStatus.Type

/** A user's box, with `nest` set when it is a Nest VM. */
export const NestUserBox = Schema.Struct({ ...UserBox.fields, nest: Schema.optional(NestBoxStatus) })
export type NestUserBox = typeof NestUserBox.Type

/** `POST ControlPaths.nestBoxes`: create a Nest box for the signed-in user. Limits default to the standard shape. */
export const CreateNestBoxBody = Schema.Struct({ name: BoxName, limits: Schema.optional(NestLimits) })
export type CreateNestBoxBody = typeof CreateNestBoxBody.Type

/** A Nest host as operators see it (Settings › Fleet). */
export const NestHostStatus = Schema.Struct({
  id: Schema.String,
  name: BoxName,
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

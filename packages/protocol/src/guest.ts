/**
 * The guest agent (`kestrel-guest-agent`, Rust, runs as root inside every Nest VM) and the two links it serves:
 *
 * - **Host link**: the host agent connects to the guest over virtio-vsock, guest port `GUEST_AGENT_VSOCK_PORT`. Cloud
 *   Hypervisor exposes the guest's vsock as a Unix socket on the host ("hybrid vsock"): the host writes
 *   `CONNECT <port>\n` and reads `OK <port>\n` before frames flow. One host connection at a time; a new one replaces the
 *   old one (after a restore the old one is dead).
 * - **Box link**: `kestrel-box` connects to the Unix socket `GUEST_AGENT_BOX_SOCKET` inside the guest, which the box
 *   finds in `CLOUDAGENTS_GUEST_AGENT_SOCKET`. The socket is mode 0600 and owned by `NEST_BOX_USER`; the guest agent
 *   accepts a connection only from that uid (SO_PEERCRED), so no other process in the VM can send `activity` or
 *   `gpuWanted`. Its presence is what makes a box report `gpu: "on-demand"` and `suspend: true`.
 *
 * Both links carry newline-delimited JSON, one frame per line, at most `MAX_GUEST_FRAME_BYTES` per line. Every frame
 * has a `_tag`. A request carries `id`; the peer answers it with exactly one `reply` with the same `id`. A line that
 * fails to decode (unknown `_tag`, or a field that does not match) is logged and dropped by the reader, so frames and
 * fields change only with a `GUEST_PROTOCOL` bump.
 *
 * The Rust guest agent mirrors these schemas with serde (`#[serde(tag = "_tag")]`, camelCase fields).
 */
import { Schema } from "effect"

/** Version of the frames below; sent in the guest's `hello`. Bump on any frame or field change (see the header). */
export const GUEST_PROTOCOL = 1
export const GUEST_AGENT_VSOCK_PORT = 1024
export const GUEST_AGENT_BOX_SOCKET = "/run/kestrel-guest/box.sock"
/** Longest line either side reads; a longer one drops the connection. */
export const MAX_GUEST_FRAME_BYTES = 64 * 1024
/** Longest `error` a reply carries; the sender cuts a longer one. */
export const GUEST_ERROR_MAX_CHARS = 1000
/** A string written into `NEST_BOX_ENV_FILE`: visible ASCII without quotes, backslashes or spaces, so no line break or quote can inject another variable. */
const EnvValue = Schema.String.pipe(Schema.maxLength(2048), Schema.pattern(/^[A-Za-z0-9._~:\/?#@!$&()*+,;=%[\]-]+$/))

/**
 * How long the host waits for each reply before it acts without the guest: a guest is user-controlled and may never
 * answer. On timeout: `prepareSuspend` → the suspend or park is aborted (the host sends `thawVolume`) and the VM keeps
 * running; `freezeVolume` → the backup is skipped (the host sends `thawVolume`); `gpuDetach` → unplug anyway; `configure`
 * and `resumed` → the VM is reported unhealthy and retried.
 */
export const GUEST_REPLY_TIMEOUT_MS = {
  configure: 120_000,
  prepareSuspend: 30_000,
  resumed: 60_000,
  gpuAttached: 60_000,
  gpuDetach: 15_000,
  freezeVolume: 30_000,
  thawVolume: 10_000,
  ping: 5_000,
} as const

/** The guest sends `status` at this interval while the host is connected. */
export const GUEST_STATUS_INTERVAL_MS = 2_000

/** The box sends `activity` on every change and at least this often. */
export const BOX_ACTIVITY_INTERVAL_MS = 10_000

/** Virtio serial of the user's volume. The guest finds it at `/dev/disk/by-id/virtio-kestrel-volume`. */
export const NEST_VOLUME_SERIAL = "kestrel-volume"
/**
 * Virtio serial of the VM's swap disk: a host-local sparse file, never backed up, recreated empty on every clone. The
 * guest runs `mkswap` on it each boot or clone and uses it behind zswap.
 */
export const NEST_SWAP_SERIAL = "kestrel-swap"
/** Where the guest mounts the volume. Everything the box keeps (data dir, home, writable Nix layer) is under it. */
export const NEST_VOLUME_MOUNT = "/var/lib/kestrel"
/** Environment file the guest agent writes on `configure`, read by `kestrel-box.service`. Root-owned, 0600. */
export const NEST_BOX_ENV_FILE = "/var/lib/kestrel/box.env"

/** The uid the box service runs as; the guest agent accepts a box-socket connection only from this uid. */
export const NEST_BOX_USER = "kestrel-box"

/**
 * The variables the guest agent writes to `NEST_BOX_ENV_FILE`, and nothing else. `enrollToken` only until the box sends
 * `enrolled`; the box stores its secret in its data dir, and the guest then rewrites the file without the token.
 */
export const NEST_BOX_ENV = {
  boxId: "CLOUDAGENTS_BOX_ID",
  controlUrl: "CLOUDAGENTS_CONTROL_URL",
  publicUrl: "CLOUDAGENTS_BOX_PUBLIC_URL",
  guestAgentSocket: "CLOUDAGENTS_GUEST_AGENT_SOCKET",
  enrollToken: "CLOUDAGENTS_NEST_ENROLL_TOKEN",
  /** `NEST_VOLUME_MOUNT`/box. */
  dataDir: "CLOUDAGENTS_DATA_DIR",
} as const

const RequestId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100))
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const Bytes = NonNegativeInt
/** A PSI `avg10` percentage, 0 to 100. */
const Psi = Schema.Number.pipe(Schema.finite(), Schema.between(0, 100))
/** A 32-byte base64url enrollment token: the form `NestEnrollToken` in nest.ts enforces. */
const EnrollToken = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/))
/** A PCI address, e.g. `0000:01:00.0`. */
const PciAddress = Schema.String.pipe(Schema.maxLength(32))

/** Answer to a request on either link. */
export const GuestReply = Schema.Struct({
  _tag: Schema.Literal("reply"),
  id: RequestId,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String.pipe(Schema.maxLength(GUEST_ERROR_MAX_CHARS))),
})
export type GuestReply = typeof GuestReply.Type

/** What keeps a VM from being idle, as the box sees it. */
export const BoxActivity = Schema.Struct({
  /** Runs that are running, holding a run slot, or waiting for one. */
  runs: NonNegativeInt,
  /** Desktop sessions that are starting or running. */
  desktops: NonNegativeInt,
  /** Clients watching a desktop or holding an event stream open. */
  viewers: NonNegativeInt,
  /** Recordings in progress. */
  recordings: NonNegativeInt,
  /** Last user input or API request the box served, ms since the epoch; null when none since start. */
  lastActivityAt: Schema.NullOr(NonNegativeInt),
})
export type BoxActivity = typeof BoxActivity.Type

/** The guest's memory and CPU pressure, which the host sizes the VM from. */
export const GuestPressure = Schema.Struct({
  memTotalBytes: Bytes,
  memAvailableBytes: Bytes,
  /** `/proc/pressure/memory` some/full avg10. */
  memSomeAvg10: Psi,
  memFullAvg10: Psi,
  /** `/proc/pressure/cpu` some avg10. */
  cpuSomeAvg10: Psi,
  /** Online vCPUs and the 1-minute load average. */
  onlineCpus: NonNegativeInt,
  loadAvg1: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
})
export type GuestPressure = typeof GuestPressure.Type

export const GpuState = Schema.Literal("none", "attaching", "attached", "detaching")
export type GpuState = typeof GpuState.Type

/** The guest's network, set by the host on `configure` (routed point-to-point: the gateway is reached on-link). */
export const GuestNetwork = Schema.Struct({
  /** IPv4 address with prefix, e.g. `10.77.0.5/32`. */
  address: Schema.String,
  gateway: Schema.String,
  /** Public IPv6 address with prefix and its on-link gateway, when the host has a routed prefix. */
  ipv6Address: Schema.NullOr(Schema.String),
  ipv6Gateway: Schema.NullOr(Schema.String),
  dns: Schema.Array(Schema.String),
  /** Host-local dependency cache and Nix binary cache origins the guest's package managers use. */
  depcacheUrl: Schema.NullOr(Schema.String),
  nixCacheUrl: Schema.NullOr(Schema.String),
  nixCachePublicKey: Schema.NullOr(Schema.String),
})
export type GuestNetwork = typeof GuestNetwork.Type

// Host -> guest agent.
export const HostToGuest = Schema.Union(
  /**
   * Give a fresh clone its identity: step the clock to `wallClockMs`, regenerate `/etc/machine-id` from `cloneId` and
   * the systemd random seed, set the network, `mkswap` and enable the swap disk, mount the volume (hot-plugged after
   * resume with serial `NEST_VOLUME_SERIAL`; wait up to 60 s for it and the swap disk, else reply `ok: false`; format
   * only a disk with no filesystem), write
   * `NEST_BOX_ENV_FILE`, and start `kestrel-box`. Idempotent; reply when the box answers its health check.
   * `enrollToken` is present only while the box has not enrolled; a newer one replaces the one in the env file.
   */
  Schema.Struct({
    _tag: Schema.Literal("configure"),
    id: RequestId,
    hostId: Schema.String,
    boxId: EnvValue,
    vmId: Schema.String,
    /** 32 lowercase hex characters, unique per clone; becomes `/etc/machine-id`. */
    cloneId: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{32}$/)),
    wallClockMs: NonNegativeInt,
    controlUrl: EnvValue,
    publicUrl: EnvValue,
    enrollToken: Schema.NullOr(EnrollToken),
    network: GuestNetwork,
  }),
  /**
   * The host is about to snapshot (suspend) or stop (park) the VM. Quiesce the box, `sync` every filesystem, drop the
   * page cache, then `fsfreeze --freeze` the volume and reply. The volume stays frozen (writes block) until the host
   * sends `thawVolume` (the suspend or park was aborted) or `resumed`. The guest never thaws on its own: the host owns
   * every freeze and ends it, and when it cannot, it stops the VM (the frozen volume is consistent, so nothing is lost
   * but memory). Park stops the VM with the volume frozen, so no write can land between the sync and the backup.
   */
  Schema.Struct({ _tag: Schema.Literal("prepareSuspend"), id: RequestId }),
  /** The VM was restored. Thaw a volume that `prepareSuspend` left frozen, step the clock to `wallClockMs`, tell the box, and reply once the box answers its health check. */
  Schema.Struct({ _tag: Schema.Literal("resumed"), id: RequestId, wallClockMs: NonNegativeInt }),
  /**
   * Periodic backup of a running VM: quiesce the box, `sync`, then `fsfreeze --freeze` the volume and reply. The host
   * reflinks the volume file and sends `thawVolume` at once. The guest never thaws on its own.
   */
  Schema.Struct({ _tag: Schema.Literal("freezeVolume"), id: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("thawVolume"), id: RequestId }),
  /** A GPU was hot-plugged at `pciAddress`. Load its driver, tell the box, reply once the device is usable. */
  Schema.Struct({ _tag: Schema.Literal("gpuAttached"), id: RequestId, pciAddress: PciAddress }),
  /**
   * Answer to the guest's `gpuWanted` with the same `id`. Denied (`granted: false`) is final for that request, and
   * `error` says why. Granted: a `wanted: true` is followed by `gpuAttached`, and the box is answered once the device is
   * usable; a `wanted: false` is followed by `gpuDetach`, and the box is answered once it is released.
   */
  Schema.Struct({
    _tag: Schema.Literal("gpuDecision"),
    id: RequestId,
    granted: Schema.Boolean,
    error: Schema.NullOr(Schema.String.pipe(Schema.maxLength(GUEST_ERROR_MAX_CHARS))),
  }),
  /** The host wants the GPU back. Have the box release it, unbind the driver, reply; the host unplugs it next. */
  Schema.Struct({ _tag: Schema.Literal("gpuDetach"), id: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("ping"), id: RequestId }),
)
export type HostToGuest = typeof HostToGuest.Type

// Guest agent -> host.
export const GuestToHost = Schema.Union(
  /** First frame on every host connection. `bootId` changes on every boot, not on restore. */
  Schema.Struct({
    _tag: Schema.Literal("hello"),
    protocol: Schema.Number.pipe(Schema.int()),
    agentVersion: Schema.String,
    /** `bootId` changes on every boot, not on restore; `cloneId` is null until the first `configure`. */
    bootId: Schema.String,
    cloneId: Schema.NullOr(Schema.String),
    configured: Schema.Boolean,
  }),
  /** Every `GUEST_STATUS_INTERVAL_MS`. `activity` is null while no box is connected. */
  Schema.Struct({
    _tag: Schema.Literal("status"),
    pressure: GuestPressure,
    activity: Schema.NullOr(BoxActivity),
    gpu: GpuState,
  }),
  /** The box wants a GPU (`true`) or is done with it (`false`); `id` is the box's request id. Answered with `gpuDecision`. */
  Schema.Struct({ _tag: Schema.Literal("gpuWanted"), id: RequestId, wanted: Schema.Boolean }),
  GuestReply,
)
export type GuestToHost = typeof GuestToHost.Type

// Box -> guest agent.
export const BoxToGuest = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("hello"), boxVersion: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("activity"), activity: BoxActivity }),
  /** The box enrolled and saved its secret: the guest rewrites `NEST_BOX_ENV_FILE` without `enrollToken`. */
  Schema.Struct({ _tag: Schema.Literal("enrolled") }),
  /**
   * The box wants a GPU (`true`) or is done with it (`false`). Answered with a `reply` to `id`: ok once the GPU is
   * attached (or released), an error when the host denies it.
   */
  Schema.Struct({ _tag: Schema.Literal("gpuWanted"), id: RequestId, wanted: Schema.Boolean }),
  GuestReply,
)
export type BoxToGuest = typeof BoxToGuest.Type

// Guest agent -> box.
export const GuestToBox = Schema.Union(
  /** Flush what the box holds in memory that must reach disk (database checkpoints), then reply. */
  Schema.Struct({ _tag: Schema.Literal("quiesce"), id: RequestId }),
  /** The VM was restored: reconnect outbound sockets (control plane), re-arm timers, then reply. */
  Schema.Struct({ _tag: Schema.Literal("resumed"), id: RequestId }),
  /** The GPU state changed. On `attached` the box restarts its desktop on the GPU renderer. */
  Schema.Struct({ _tag: Schema.Literal("gpuState"), state: GpuState, pciAddress: Schema.NullOr(Schema.String) }),
  /** Stop everything using the GPU (the desktop falls back to software rendering), then reply. */
  Schema.Struct({ _tag: Schema.Literal("releaseGpu"), id: RequestId }),
  GuestReply,
)
export type GuestToBox = typeof GuestToBox.Type

export const decodeHostToGuest = Schema.decodeUnknownEither(Schema.parseJson(HostToGuest))
export const decodeGuestToHost = Schema.decodeUnknownEither(Schema.parseJson(GuestToHost))
export const decodeBoxToGuest = Schema.decodeUnknownEither(Schema.parseJson(BoxToGuest))
export const decodeGuestToBox = Schema.decodeUnknownEither(Schema.parseJson(GuestToBox))

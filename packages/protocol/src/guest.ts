/**
 * The guest agent (`kestrel-guest-agent`, Rust, runs as root inside every Nest VM) and the two links it serves:
 *
 * - **Host link**: the host agent connects to the guest over virtio-vsock, guest port `GUEST_AGENT_VSOCK_PORT`. Cloud
 *   Hypervisor exposes the guest's vsock as a Unix socket on the host ("hybrid vsock"): the host writes
 *   `CONNECT <port>\n` and reads `OK <port>\n` before frames flow. One host connection at a time; a new one replaces the
 *   old one (after a restore the old one is dead).
 * - **Box link**: `kestrel-box` connects to the Unix socket `GUEST_AGENT_BOX_SOCKET` inside the guest, which the box
 *   finds in `CLOUDAGENTS_GUEST_AGENT_SOCKET`. Its presence is what makes a box report `gpu: "on-demand"` and
 *   `suspend: true`.
 *
 * Both links carry newline-delimited JSON, one frame per line, at most `MAX_GUEST_FRAME_BYTES` per line. Every frame
 * has a `_tag`. A request carries `id`; the peer answers it with exactly one `reply` with the same `id`. Unknown tags
 * are ignored, so either side may add frames without a version bump.
 *
 * The Rust guest agent mirrors these schemas with serde (`#[serde(tag = "_tag")]`, camelCase fields).
 */
import { Schema } from "effect"

export const GUEST_AGENT_VSOCK_PORT = 1024
export const GUEST_AGENT_BOX_SOCKET = "/run/kestrel-guest/box.sock"
export const MAX_GUEST_FRAME_BYTES = 64 * 1024

/** The guest sends `status` at this interval while the host is connected. */
export const GUEST_STATUS_INTERVAL_MS = 2_000

/** The box sends `activity` on every change and at least this often. */
export const BOX_ACTIVITY_INTERVAL_MS = 10_000

/** Virtio serial of the user's volume. The guest finds it at `/dev/disk/by-id/virtio-kestrel-volume`. */
export const NEST_VOLUME_SERIAL = "kestrel-volume"
/** Where the guest mounts the volume. Everything the box keeps (data dir, home, writable Nix layer) is under it. */
export const NEST_VOLUME_MOUNT = "/var/lib/kestrel"
/** Environment file the guest agent writes on `configure`, read by `kestrel-box.service`. Root-owned, 0600. */
export const NEST_BOX_ENV_FILE = "/var/lib/kestrel/box.env"

const RequestId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100))
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
const Bytes = NonNegativeInt
/** A PSI `avg10` percentage, 0 to 100. */
const Psi = Schema.Number.pipe(Schema.finite(), Schema.between(0, 100))

/** Answer to a request on either link. */
export const GuestReply = Schema.Struct({
  _tag: Schema.Literal("reply"),
  id: RequestId,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
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
   * Give a fresh clone its identity: set the network, mount the volume (hot-plugged with serial `NEST_VOLUME_SERIAL`,
   * formatted on first use), write `NEST_BOX_ENV_FILE`, and start `kestrel-box`. Idempotent; reply when the box
   * answers its health check. `enrollToken` is present only for a box that has no secret yet.
   */
  Schema.Struct({
    _tag: Schema.Literal("configure"),
    id: RequestId,
    hostId: Schema.String,
    boxId: Schema.String,
    vmId: Schema.String,
    controlUrl: Schema.String,
    publicUrl: Schema.String,
    enrollToken: Schema.NullOr(Schema.String),
    network: GuestNetwork,
  }),
  /**
   * The host is about to snapshot (suspend) or stop (park) the VM. Quiesce the box, `sync` every filesystem and drop the
   * page cache, so the saved memory is small and the volume alone is consistent. Reply when done; the host pauses next.
   */
  Schema.Struct({ _tag: Schema.Literal("prepareSuspend"), id: RequestId }),
  /** The VM was restored. Step the clock to `wallClockMs`, tell the box, reply. */
  Schema.Struct({ _tag: Schema.Literal("resumed"), id: RequestId, wallClockMs: NonNegativeInt }),
  /** A GPU was hot-plugged at `pciAddress`. Load its driver, tell the box, reply once the device is usable. */
  Schema.Struct({ _tag: Schema.Literal("gpuAttached"), id: RequestId, pciAddress: Schema.String }),
  /** The host wants the GPU back. Have the box release it, unbind the driver, reply; the host unplugs it next. */
  Schema.Struct({ _tag: Schema.Literal("gpuDetach"), id: RequestId }),
  /** Clean power-off (park, destroy). Reply, then shut down. */
  Schema.Struct({ _tag: Schema.Literal("shutdown"), id: RequestId }),
  Schema.Struct({ _tag: Schema.Literal("ping"), id: RequestId }),
)
export type HostToGuest = typeof HostToGuest.Type

// Guest agent -> host.
export const GuestToHost = Schema.Union(
  /** First frame on every host connection. `bootId` changes on every boot, not on restore. */
  Schema.Struct({
    _tag: Schema.Literal("hello"),
    agentVersion: Schema.String,
    bootId: Schema.String,
    configured: Schema.Boolean,
  }),
  /** Every `GUEST_STATUS_INTERVAL_MS`. `activity` is null while no box is connected. */
  Schema.Struct({
    _tag: Schema.Literal("status"),
    pressure: GuestPressure,
    activity: Schema.NullOr(BoxActivity),
    gpu: GpuState,
  }),
  /** The box wants a GPU (`true`) or is done with it (`false`). The host decides and answers with frames above. */
  Schema.Struct({ _tag: Schema.Literal("gpuWanted"), wanted: Schema.Boolean }),
  GuestReply,
)
export type GuestToHost = typeof GuestToHost.Type

// Box -> guest agent.
export const BoxToGuest = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("hello"), boxVersion: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("activity"), activity: BoxActivity }),
  Schema.Struct({ _tag: Schema.Literal("gpuWanted"), wanted: Schema.Boolean }),
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

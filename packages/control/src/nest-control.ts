/**
 * Pure Nest control-plane rules: placement, the epoch decision for a reported VM, command deadlines, enrollment
 * tokens and the status a box shows its owner. The Hub's Nest code (`nest-fleet.ts`) applies them to SQLite.
 */
import {
  type NestBoxStatus,
  type NestHostCapacity,
  type NestHostCommand,
  type NestLimits,
  type NestVmReport,
  toBase64,
} from "@cloudagents/protocol"
import type { NestBoxRow } from "./nest-table"

const GiB = 1024 * 1024 * 1024
const MiB = 1024 * 1024

/**
 * The limits a box gets when its creator names none. The contract says "the standard shape" without listing it, so
 * this is the control plane's choice; a shape is a per-box setting and can be changed with `setLimits`.
 */
export const NEST_STANDARD_LIMITS: NestLimits = {
  maxVcpus: 4,
  maxMemoryBytes: 8 * GiB,
  gpu: "none",
  volumeBytes: 64 * GiB,
}

/** A fresh VM boots with 1 GiB plugged; a placement needs that plus the smallest headroom the resource policy keeps. */
export const NEST_BOOT_MEMORY_BYTES = 1 * GiB
export const NEST_PLACEMENT_HEADROOM_BYTES = 512 * MiB

/** How long the control plane waits for a host's `result` before it drops the in-flight marker. `evict` is not tracked. */
const COMMAND_TIMEOUT_MS: Record<NestHostCommand["_tag"], number | null> = {
  create: 15 * 60_000,
  resume: 10 * 60_000,
  suspend: 10 * 60_000,
  park: 15 * 60_000,
  setLimits: 2 * 60_000,
  gpuAttach: 5 * 60_000,
  gpuDetach: 5 * 60_000,
  destroy: 15 * 60_000,
  evict: null,
}

export const commandTimeoutMs = (tag: NestHostCommand["_tag"]): number | null => COMMAND_TIMEOUT_MS[tag]

/** Why a limits shape is refused, or null. A box must be able to boot its VM's memory. */
export const nestLimitsError = (limits: NestLimits): string | null =>
  limits.maxMemoryBytes < NEST_BOOT_MEMORY_BYTES ? `maxMemoryBytes must be at least ${NEST_BOOT_MEMORY_BYTES}` : null

/** `https://<boxId>.<host slug>.<nest domain>`: the box's origin on the host it is placed on. */
export const publicUrlFor = (boxId: string, slug: string, domain: string): string =>
  `https://${boxId}.${slug}.${domain}`

/** A connected host with a known slug, as placement sees it. */
export type PlacementCandidate = { hostId: string; slug: string; capacity: NestHostCapacity }

/**
 * The connected host with the most free memory that still fits a VM booting with `NEST_BOOT_MEMORY_BYTES` plus
 * headroom, and whose free disk holds the memory image a suspend of that VM would write. `preferred` wins whenever it
 * fits, whatever the others have free: a parked box goes back to the host its request reached when that host has room.
 * Ties go to the lower host id, so placement is deterministic. Null when no host fits; the caller holds the box until
 * one does.
 */
export const placeHost = (candidates: PlacementCandidate[], preferred: string | null = null): PlacementCandidate | null => {
   const need = NEST_BOOT_MEMORY_BYTES + NEST_PLACEMENT_HEADROOM_BYTES
   const fits = candidates.filter(
     ({ capacity }) =>
       capacity.memoryBytes - capacity.memoryPluggedBytes >= need && capacity.diskFreeBytes >= NEST_BOOT_MEMORY_BYTES,
   )
  const named = fits.find((candidate) => candidate.hostId === preferred)
  if (named !== undefined) return named
  let best: PlacementCandidate | null = null
  for (const candidate of fits) {
    if (best === null) {
      best = candidate
      continue
    }
    const free = candidate.capacity.memoryBytes - candidate.capacity.memoryPluggedBytes
    const bestFree = best.capacity.memoryBytes - best.capacity.memoryPluggedBytes
    if (free > bestFree || (free === bestFree && candidate.hostId < best.hostId)) best = candidate
  }
  return best
}

/**
 * `capacity` once `boots` VMs booting on this host (a create or resume in flight) have taken their boot memory and their
 * memory image's disk. Placement sees these as used, so two placements never book the same space.
 */
export const withPlannedBoots = (capacity: NestHostCapacity, boots: number): NestHostCapacity => ({
  ...capacity,
  memoryPluggedBytes: capacity.memoryPluggedBytes + boots * NEST_BOOT_MEMORY_BYTES,
  diskFreeBytes: capacity.diskFreeBytes - boots * NEST_BOOT_MEMORY_BYTES,
})

export type VmDecision = { _tag: "evict" } | { _tag: "apply" } | { _tag: "ignore"; reason: string }

/**
 * What the control plane does with a VM a host reports. A lower epoch than the box's means the box was placed
 * elsewhere since: the host must evict its copy. A higher epoch than the control plane's, a different host at the
 * same epoch, or a different VM incarnation is inconsistent, so the report is ignored and logged.
 */
export const decideVm = (row: NestBoxRow | null, hostId: string, report: NestVmReport): VmDecision => {
  if (row === null) return { _tag: "ignore", reason: "unknown box" }
  if (report.ownerEpoch < row.ownerEpoch) return { _tag: "evict" }
  if (report.ownerEpoch > row.ownerEpoch) return { _tag: "ignore", reason: "epoch ahead of the control plane" }
  if (row.hostId !== hostId) return { _tag: "ignore", reason: "box is parked or placed on another host" }
  if (report.vmId !== row.vmId) return { _tag: "ignore", reason: "different VM incarnation" }
  return { _tag: "apply" }
}

/** 32 random bytes, base64url: a box secret, or an enrollment token (the form `NestEnrollToken` accepts). */
export const newSecret = (): string =>
  toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const enrollTokenHash = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * How many times a park or destroy the host refused for a lapse is sent again, one per lease renewal. A refusal runs
 * nothing, so a resend cannot repeat a side effect; the bound stops a host whose clock keeps it lapsed from looping.
 */
export const MAX_LAPSE_RETRIES = 3

/** The owner's view of a box's VM. A `create` in flight is not shown as pending: the box is already `provisioning`. */
export const nestStatusOf = (row: NestBoxRow): NestBoxStatus => ({
  state: row.state,
  failed: row.createFailed,
  pending:
    row.pendingKind === null || row.pendingKind === "create" || row.pendingKind === "evict" ? null : row.pendingKind,
  limits: row.limits,
  vcpus: row.vcpus,
  memoryBytes: row.memoryBytes,
  gpus: row.gpus,
})

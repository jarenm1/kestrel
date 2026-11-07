import type { GuestNetwork } from "@cloudagents/protocol"
import { Schema } from "effect"
import { HostError } from "./errors"
import type { NestNetwork } from "./schema"
import type { ToolResult } from "./tools"

/**
 * Per-VM networking. Each VM owns one tap device `kn-<slot>` and one IPv4 /32 address, routed point-to-point:
 * the host holds `HOST_GATEWAY` on every tap, and the guest's default route is that gateway, reached on-link.
 * There is no bridge, so guests cannot reach each other at layer 2.
 */

export const HOST_GATEWAY = "169.254.0.1"
const SUBNET_PREFIX = "10.77"
/** Slot 0 and 1 are reserved (network and host-side numbering). */
const FIRST_SLOT = 2
const LAST_SLOT = 65533
/** Vsock context ids 0-2 are reserved; a VM's cid is its slot plus this offset. */
const CID_BASE = 2
/** Fixed NIC MAC for every VM. Taps are point-to-point, so VMs never share a segment. */
export const GUEST_MAC = "52:54:00:4b:4e:01"

/** The host NixOS module (`nix/host-module.nix`) declares the `inet kestrel` table, its chains and the `tap_addrs` set, and owns them. The agent only adds and deletes elements of `tap_addrs`. */
export const NFT_TABLE = "kestrel"
/** One `ifname . address` element per live tap: the only source a tap may send from. */
export const TAP_ADDRS_SET = "tap_addrs"

export const slotAddress = (slot: number): string => `${SUBNET_PREFIX}.${Math.floor(slot / 256)}.${slot % 256}`

export const slotTap = (slot: number): string => `kn-${slot}`

export const slotCid = (slot: number): number => slot + CID_BASE

/** Lowest free slot at or above FIRST_SLOT. Throws when the subnet is exhausted. */
export const allocateSlot = (used: ReadonlySet<number>): number => {
  for (let slot = FIRST_SLOT; slot <= LAST_SLOT; slot++) {
    if (!used.has(slot)) return slot
  }
  throw new HostError("no free network slot left on this host")
}

/** The network a VM is configured with for a given slot. */
export const networkForSlot = (slot: number): NestNetwork => ({
  slot,
  address: slotAddress(slot),
  cid: slotCid(slot),
  tap: slotTap(slot),
})

/** Guest-side view sent in `configure`. IPv6 is not routed here, so both IPv6 fields are null. DNS is the host's unbound. */
export const guestNetwork = (
  network: NestNetwork,
  opts: {
    readonly depcacheUrl: string | null
    readonly nixCacheUrl: string | null
    readonly nixCachePublicKey: string | null
  },
): GuestNetwork => ({
  address: `${network.address}/32`,
  gateway: HOST_GATEWAY,
  ipv6Address: null,
  ipv6Gateway: null,
  dns: [HOST_GATEWAY],
  depcacheUrl: opts.depcacheUrl,
  nixCacheUrl: opts.nixCacheUrl,
  nixCachePublicKey: opts.nixCachePublicKey,
})

/** A command as argv; the caller runs it with `runTool`. */
export type NetCommand = readonly string[]

/** The set element that allows one tap to send only from its VM's address. */
const tapAddrsElement = (network: NestNetwork): string => `"${network.tap}" . ${network.address}`

/** Adds the tap's element to `tap_addrs` when its tap comes up. */
export const tapAddrsAddCommand = (network: NestNetwork): NetCommand => [
  "nft",
  "add",
  "element",
  "inet",
  NFT_TABLE,
  TAP_ADDRS_SET,
  `{ ${tapAddrsElement(network)} }`,
]

/** The `nft -j list set` listing of `tap_addrs`. Only the element pairs `[ifname, address]` are read. */
const TapAddrsListing = Schema.Struct({
  nftables: Schema.Array(
    Schema.Struct({
      set: Schema.optional(
        Schema.Struct({
          elem: Schema.optional(Schema.Array(Schema.Struct({ concat: Schema.Tuple(Schema.String, Schema.String) }))),
        }),
      ),
    }),
  ),
})

/** Arguments to `nft` that list the elements of `tap_addrs` as JSON, for `checkTapAddrs`. */
export const tapAddrsListArgs: readonly string[] = ["-j", "list", "set", "inet", NFT_TABLE, TAP_ADDRS_SET]

/**
 * The live taps whose element `tap_addrs` lacks, given its JSON listing. A reload of the nftables service flushes the
 * set while taps keep running, so the caller re-adds these. Throws on a listing it cannot read, rather than guessing
 * which taps are covered.
 */
export const missingTapAddrs = (listing: string, lives: readonly NestNetwork[]): NestNetwork[] => {
  const decoded = Schema.decodeUnknownSync(TapAddrsListing)(JSON.parse(listing))
  const present = new Set(
    decoded.nftables.flatMap((entry) =>
      (entry.set?.elem ?? []).map((element) => `${element.concat[0]} ${element.concat[1]}`),
    ),
  )
  return lives.filter((network) => !present.has(`${network.tap} ${network.address}`))
}

/** What a check of `tap_addrs` finds: the set does not exist, or it exists and lacks these live taps' elements. */
export type TapAddrsCheck =
  | { readonly kind: "missing-set"; readonly reason: string }
  | { readonly kind: "present"; readonly missing: readonly NestNetwork[] }

/**
 * Decides, from the result of `nft` run with `tapAddrsListArgs`, whether the set exists and which live taps need their
 * element re-added. A failed listing means the set is absent: the agent never creates the table or the set.
 */
export const checkTapAddrs = (listing: ToolResult, lives: readonly NestNetwork[]): TapAddrsCheck =>
  listing.status === 0
    ? { kind: "present", missing: missingTapAddrs(listing.stdout, lives) }
    : { kind: "missing-set", reason: listing.stderr.trim() }

/** Creates a tap, gives it the host side of the point-to-point link, and routes the guest address to it. */
export const tapUpCommands = (network: NestNetwork, egressMbit: number): NetCommand[] => [
  ["ip", "tuntap", "add", "dev", network.tap, "mode", "tap"],
  ["ip", "link", "set", "dev", network.tap, "up"],
  ["ip", "addr", "replace", `${HOST_GATEWAY}/32`, "dev", network.tap],
  ["ip", "route", "replace", `${network.address}/32`, "dev", network.tap],
  ["tc", "qdisc", "replace", "dev", network.tap, "root", "tbf", "rate", `${egressMbit}mbit`, "burst", "1mb", "latency", "50ms"],
  ["tc", "qdisc", "replace", "dev", network.tap, "ingress"],
  [
    "tc",
    "filter",
    "replace",
    "dev",
    network.tap,
    "parent",
    "ffff:",
    "protocol",
    "all",
    "matchall",
    "action",
    "police",
    "rate",
    `${egressMbit}mbit`,
    "burst",
    "1mb",
    "conform-exceed",
    "drop",
  ],
  tapAddrsAddCommand(network),
]

export const tapDownCommands = (network: NestNetwork): NetCommand[] => [
  ["nft", "delete", "element", "inet", NFT_TABLE, TAP_ADDRS_SET, `{ ${tapAddrsElement(network)} }`],
  ["ip", "link", "del", "dev", network.tap],
]

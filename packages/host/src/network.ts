import type { GuestNetwork } from "@cloudagents/protocol"
import { Schema } from "effect"
import { HostError } from "./errors"
import type { NestNetwork } from "./schema"

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

/** The agent owns the guest firewall: the `inet kestrel` table, and `ip kestrel-nat` for egress. */
export const NFT_TABLE = "kestrel"
export const NFT_NAT_TABLE = "kestrel-nat"
/** One `ifname . address` element per live tap: the only source a tap may send from. */
export const TAP_ADDRS_SET = "tap_addrs"

/** Ports of the host services a guest may reach on `HOST_GATEWAY`: the dependency cache, the Nix cache and DNS. */
const GATEWAY_TCP_PORTS = [3141, 5000, 53]
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"]

/**
 * The whole guest firewall as one `nft -f` script. The script destroys and rebuilds both tables with the live taps'
 * elements in the same transaction, so a reload restores every running tap's anti-spoofing rule at once. It is loaded
 * before any tap is brought up, so a guest never has a tap without its anti-spoofing rule. Traffic not from a tap is
 * not touched.
 */
export const firewallRuleset = (taps: readonly NestNetwork[]): string =>
  [
    `destroy table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    `  set ${TAP_ADDRS_SET} {`,
    "    type ifname . ipv4_addr",
    ...(taps.length === 0 ? [] : [`    elements = { ${taps.map(tapAddrsElement).join(", ")} }`]),
    "  }",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    "    ct state established,related accept",
    `    iifname "kn-*" ip daddr ${HOST_GATEWAY} tcp dport { ${GATEWAY_TCP_PORTS.join(", ")} } accept`,
    `    iifname "kn-*" ip daddr ${HOST_GATEWAY} udp dport 53 accept`,
    '    iifname "kn-*" drop',
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    `    iifname "kn-*" iifname . ip saddr != @${TAP_ADDRS_SET} drop`,
    '    iifname "kn-*" meta nfproto ipv6 drop',
    `    iifname "kn-*" ip daddr { ${PRIVATE_RANGES.join(", ")} } drop`,
    '    iifname "kn-*" oifname != "kn-*" accept',
    '    iifname "kn-*" drop',
    "  }",
    "}",
    `destroy table ip ${NFT_NAT_TABLE}`,
    `table ip ${NFT_NAT_TABLE} {`,
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    `    ip saddr ${SUBNET_PREFIX}.0.0/16 oifname != "kn-*" masquerade`,
    "  }",
    "}",
    "",
  ].join("\n")

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

/** Arguments to `nft` that list the elements of `tap_addrs` as JSON, for `missingTapAddrs`. */
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

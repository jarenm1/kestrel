import type { GuestNetwork } from "@cloudagents/protocol"
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

/** Guest-side view sent in `configure`. IPv6 is not routed here, so both IPv6 fields are null. */
export const guestNetwork = (
  network: NestNetwork,
  opts: {
    readonly dns: readonly string[]
    readonly depcacheUrl: string | null
    readonly nixCacheUrl: string | null
    readonly nixCachePublicKey: string | null
  },
): GuestNetwork => ({
  address: `${network.address}/32`,
  gateway: HOST_GATEWAY,
  ipv6Address: null,
  ipv6Gateway: null,
  dns: [...opts.dns],
  depcacheUrl: opts.depcacheUrl,
  nixCacheUrl: opts.nixCacheUrl,
  nixCachePublicKey: opts.nixCachePublicKey,
})

/** A command as argv; the caller runs it with `runTool`. */
export type NetCommand = readonly string[]

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
]

export const tapDownCommands = (network: NestNetwork): NetCommand[] => [
  ["ip", "link", "del", "dev", network.tap],
]

/** Names of the nft tables that enforce the guest firewall. */
export const NFT_TABLE = "kestrel"
export const NFT_NAT_TABLE = "kestrel-nat"

/** Ports the guest may reach on the host gateway: the dependency cache, the Nix cache, and DNS. */
export const GUEST_GATEWAY_TCP_PORTS = { depcache: 3141, nixCache: 5000 } as const

/** Private and link-local ranges that guests must never reach directly (other guests, host services, LAN). */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]

/**
 * The complete nft ruleset for the current VMs (flush-and-replace semantics: callers load it with `nft -f`).
 * Input: each guest may reach only the gateway's cache ports and DNS. Forward: each tap may only send with its
 * own address, may reach the public internet and the configured resolvers, and may not reach private ranges.
 * NAT: guest egress is masqueraded to the host's public side.
 */
export const nftRuleset = (
  networks: readonly NestNetwork[],
  opts: { readonly dnsServers: readonly string[] },
): string => {
  const antiSpoof = networks.map(
    (network) => `    iifname "${network.tap}" ip saddr != ${network.address} drop`,
  )
  const dns = opts.dnsServers.join(", ")
  const lines = [
    `add table inet ${NFT_TABLE}`,
    `flush table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    `  chain input {`,
    `    type filter hook input priority filter; policy accept;`,
    `    iifname "kn-*" ip daddr ${HOST_GATEWAY} tcp dport { ${GUEST_GATEWAY_TCP_PORTS.depcache}, ${GUEST_GATEWAY_TCP_PORTS.nixCache} } accept`,
    `    iifname "kn-*" ip daddr ${HOST_GATEWAY} udp dport 53 accept`,
    `    iifname "kn-*" drop`,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority filter; policy drop;`,
    `    ct state established,related accept`,
    ...antiSpoof,
    `    iifname "kn-*" meta nfproto ipv6 drop`,
    `    iifname "kn-*" ip daddr { ${PRIVATE_RANGES.join(", ")} } drop`,
    dns === "" ? "" : `    iifname "kn-*" ip daddr { ${dns} } meta l4proto { tcp, udp } th dport 53 accept`,
    `    iifname "kn-*" oifname != "kn-*" accept`,
    `  }`,
    `}`,
    `add table ip ${NFT_NAT_TABLE}`,
    `flush table ip ${NFT_NAT_TABLE}`,
    `table ip ${NFT_NAT_TABLE} {`,
    `  chain postrouting {`,
    `    type nat hook postrouting priority srcnat; policy accept;`,
    `    ip saddr ${SUBNET_PREFIX}.0.0/16 oifname != "kn-*" masquerade`,
    `  }`,
    `}`,
  ]
  return `${lines.filter((line) => line !== "").join("\n")}\n`
}

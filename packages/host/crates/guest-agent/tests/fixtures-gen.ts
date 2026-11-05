/**
 * Writes `tests/fixtures/guest-frames.json`: one frame per variant of the four guest-link unions, each encoded by the
 * TypeScript schemas in `packages/protocol/src/guest.ts`, plus `boxEnv`, the variable names of `NEST_BOX_ENV`. The Rust
 * unit tests decode every frame and re-encode it to the same JSON (`src/protocol.rs`), and the box env writer must
 * produce exactly the pinned names (`src/configure.rs`), so drift fails there.
 *
 * Regenerate after changing the contract: `bun run tests/fixtures-gen.ts` (from this crate directory).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { BoxToGuest, GuestToBox, GuestToHost, HostToGuest, NEST_BOX_ENV, NEST_BOX_USER } from "../../../../protocol/src/guest"

const network = {
  address: "10.77.0.5/32",
  gateway: "10.77.0.1",
  ipv6Address: "2001:db8:77::5/64",
  ipv6Gateway: "fe80::1",
  dns: ["10.77.0.1", "1.1.1.1"],
  depcacheUrl: "http://10.77.0.1:8081",
  nixCacheUrl: "http://10.77.0.1:8082",
  nixCachePublicKey: "kestrel-cache-1:AAAA0000=",
}

const pressure = {
  memTotalBytes: 2147483648,
  memAvailableBytes: 1073741824,
  memSomeAvg10: 12.5,
  memFullAvg10: 0.25,
  cpuSomeAvg10: 3.75,
  onlineCpus: 2,
  loadAvg1: 0.5,
}

const activity = {
  runs: 1,
  desktops: 0,
  viewers: 2,
  recordings: 0,
  lastActivityAt: 1767225600000,
}

const hostToGuest: ReadonlyArray<HostToGuest> = [
  {
    _tag: "configure",
    id: "req-1",
    hostId: "host-a",
    boxId: "box-1",
    vmId: "vm-1",
    cloneId: "0123456789abcdef0123456789abcdef",
    wallClockMs: 1767225600000,
    controlUrl: "https://control.example.test",
    publicUrl: "https://vm-1.example.test",
    enrollToken: "x".repeat(43),
    network,
  },
  {
    _tag: "configure",
    id: "req-2",
    hostId: "host-a",
    boxId: "box-1",
    vmId: "vm-1",
    cloneId: "0123456789abcdef0123456789abcdef",
    wallClockMs: 1767225600000,
    controlUrl: "https://control.example.test",
    publicUrl: "https://vm-1.example.test",
    enrollToken: null,
    network: { ...network, ipv6Address: null, ipv6Gateway: null, depcacheUrl: null, nixCacheUrl: null, nixCachePublicKey: null },
  },
  { _tag: "prepareSuspend", id: "req-3" },
  { _tag: "resumed", id: "req-4", wallClockMs: 1767225700000 },
  { _tag: "freezeVolume", id: "req-5" },
  { _tag: "thawVolume", id: "req-6" },
  { _tag: "gpuAttached", id: "req-7", pciAddress: "0000:01:00.0" },
  { _tag: "gpuDetach", id: "req-8" },
  { _tag: "gpuDecision", id: "req-9", granted: true, error: null },
  { _tag: "gpuDecision", id: "req-11", granted: false, error: "GPU is already attached to another box" },
  { _tag: "ping", id: "req-10" },
]

const guestToHost: ReadonlyArray<GuestToHost> = [
  { _tag: "hello", protocol: 1, agentVersion: "0.1.0", bootId: "boot-1", cloneId: null, configured: false },
  {
    _tag: "hello",
    protocol: 1,
    agentVersion: "0.1.0",
    bootId: "boot-2",
    cloneId: "0123456789abcdef0123456789abcdef",
    configured: true,
  },
  { _tag: "status", pressure, activity: null, gpu: "none" },
  { _tag: "status", pressure, activity, gpu: "attached" },
  { _tag: "gpuWanted", id: "req-12", wanted: true },
  { _tag: "reply", id: "req-1", ok: true },
  { _tag: "reply", id: "req-2", ok: false, error: "volume did not appear within 60s" },
]

const boxToGuest: ReadonlyArray<BoxToGuest> = [
  { _tag: "hello", boxVersion: "2026.1.0" },
  { _tag: "activity", activity },
  { _tag: "activity", activity: { ...activity, lastActivityAt: null } },
  { _tag: "gpuWanted", id: "req-11", wanted: false },
  { _tag: "enrolled" },
  { _tag: "reply", id: "req-3", ok: true },
]

const guestToBox: ReadonlyArray<GuestToBox> = [
  { _tag: "quiesce", id: "req-3" },
  { _tag: "resumed", id: "req-4" },
  { _tag: "gpuState", state: "attached", pciAddress: "0000:01:00.0" },
  { _tag: "gpuState", state: "none", pciAddress: null },
  { _tag: "releaseGpu", id: "req-8" },
  { _tag: "reply", id: "req-4", ok: true },
]

const fixtures = {
  hostToGuest: hostToGuest.map((frame) => Schema.encodeSync(HostToGuest)(frame)),
  guestToHost: guestToHost.map((frame) => Schema.encodeSync(GuestToHost)(frame)),
  boxToGuest: boxToGuest.map((frame) => Schema.encodeSync(BoxToGuest)(frame)),
  guestToBox: guestToBox.map((frame) => Schema.encodeSync(GuestToBox)(frame)),
  boxEnv: NEST_BOX_ENV,
  boxUser: NEST_BOX_USER,
}

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, "fixtures"), { recursive: true })
writeFileSync(join(here, "fixtures", "guest-frames.json"), `${JSON.stringify(fixtures, null, 2)}\n`)
const frameCount = fixtures.hostToGuest.length + fixtures.guestToHost.length + fixtures.boxToGuest.length + fixtures.guestToBox.length
console.log(`wrote ${frameCount} frames and ${Object.keys(NEST_BOX_ENV).length} box env names`)

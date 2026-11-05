# @cloudagents/host (`kestrel-host`)

The host agent for Nest: one daemon per Linux host that runs per-user VMs on Cloud Hypervisor. It owns VM lifecycle
(boot from the shared template, idle suspend, park, wake, destroy), live vCPU and memory resizing, on-demand GPU
hot-plug, lazy volumes, wake-on-request ingress, and metering. The design and every interface are in `docs/nest.md`;
wire formats are in `packages/protocol/src/nest.ts` (host to control plane) and `packages/protocol/src/guest.ts`
(host to guest agent, box to guest agent).

## Commands

```
kestrel-host daemon [--config /etc/kestrel-host/config.json]
kestrel-host vm list [--socket /run/kestrel-host/operator.sock]
kestrel-host vm show <boxId>      [--socket ...]
kestrel-host vm suspend <boxId>   [--socket ...]
kestrel-host vm park <boxId>      [--socket ...]
kestrel-host vm destroy <boxId>   [--socket ...]
```

Exit codes: 0 success, 1 operational failure, 2 usage error. `vm` commands talk to a running daemon through its local
API; they do not touch VMs directly.

## Configuration

`/etc/kestrel-host/config.json`, validated strictly (unknown keys are refused). Paths are absolute. Durations are
milliseconds. The host secret is read from `hostSecretFile` at start and is never part of this file.

| Field | Meaning |
| --- | --- |
| `hostId`, `slug`, `agentVersion` | Identity reported in `hello` |
| `controlUrl`, `meterUrl`, `hostSecretFile` | Control plane WebSocket base, meter origin, bearer secret |
| `stateDir`, `runDir`, `nestDomain` | State (`stateDir`), local API socket dir (`runDir`), ingress domain |
| `cloudHypervisor`, `volumeTool` | Binaries for the VMM and `kestrel-volume` |
| `guestImageDir` | Directory with `manifest.json` (`imageId`, `kernel`, `initrd`, `store`, `cmdline`) |
| `volumeStore`, `volumeKeyFile` | `kestrel-volume` store URL; key file (or `null` when unencrypted) |
| `scope` | `systemd-system` or `systemd-user` (VMM in a transient scope under `kestrel-vms.slice`), or `none` (smoke tests) |
| `template.maxVcpus`, `template.maxMemoryBytes` | Shape of the shared template VM |
| `capacity.vcpus`, `capacity.memoryBytes` | Capacity advertised to the control plane |
| `gpus` | `[{pciAddress, model, vramBytes}]` |
| `egressMbit` | Per-VM egress shaping |
| `idleSuspendAfterMs`, `parkAfterMs`, `backupIntervalMs`, `meterIntervalMs` | Lifecycle and metering intervals |
| `depcacheUrl`, `nixCacheUrl`, `nixCachePublicKey` | Dependency cache and Nix binary cache (or `null`) |

## State directory

```
commands.json            command outcomes for dedupe (newest 512), with a reported flag
templates/               the shared template VM (memory image, config, metadata)
vms/<boxId>/vm.json      VM record (schema-checked); written atomically
vms/<boxId>/volume.raw   lazy data volume served by kestrel-volume
vms/<boxId>/swap.raw     4 GiB sparse swap
vms/<boxId>/restore/     snapshot files for this VM's restore (Copy mode unless /dev/userfaultfd is usable by this user)
vms/<boxId>/api.sock     Cloud Hypervisor API socket
vms/<boxId>/vsock.sock   hybrid vsock to the guest agent (port 1024)
vms/<boxId>/console.log  serial console
vms/<boxId>/snapshot.<n> snapshot generations
meter/                   usage records waiting to ship (outbox, capped at 50,000)
lock                     single-instance lock for the daemon (pid, start time)
```

Every JSON write is atomic (temp file, fsync, rename, directory fsync). A daemon restart adopts running VMs from their
records; it does not stop them.

## Control link

The daemon keeps one WebSocket to `ControlPaths.nestHostConnect` with `Authorization: Bearer <secret>` and the
`x-kestrel-nest-host` header.

- Every connection starts with `hello` (capacity, VM reports, unreported command results). Capacity is re-sent every
  60 s. VM changes are sent as they happen; while disconnected they are not queued, because the next `hello` carries
  every VM.
- Commands run through the manager and each is answered with `result`. A result is marked reported only after the
  socket accepted it, so a result finished while disconnected goes out on the next `hello`. The protocol has no ack,
  so a result written just before a socket drop can be lost; the control plane must tolerate a missing result.
- Reconnects use jittered backoff from 1 s to 60 s. After a `refused` frame the link waits 10 minutes.
- Frames over `MAX_NEST_FRAME_BYTES` or that fail to decode close the socket.

## Local API

Two Unix sockets in `<runDir>`. The directory is mode 0750 and group `kestrel-ingress`. Unknown boxes return 404.

`api.sock` (mode 0660, group `kestrel-ingress`) is the ingress surface and nothing else:

| Route | Result |
| --- | --- |
| `GET /v1/boxes/:boxId/route` | `{state, upstream}` |
| `POST /v1/boxes/:boxId/wake` | `{upstream}`; 503 `{error}` when the box does not reach running in time |
| `POST /v1/ingress/activity` | body `{boxes:[{boxId, openConnections, lastRequestAt}]}`; 204 |

`operator.sock` (mode 0600, owned by the agent's user, root) is the operator surface. The `kestrel-ingress` group cannot
connect to it, so a compromised ingress cannot destroy or park boxes. The `kestrel-host vm` commands default to it.

| Route | Result |
| --- | --- |
| `GET /v1/vms` | `NestVmReport[]` |
| `GET /v1/boxes/:boxId` | VM report (404 if not on this host) |
| `POST /v1/boxes/:boxId/suspend` / `park` / `destroy` | `{ok, error, vm}`; 409 when refused |

## Metering

Usage is measured per VM (CPU from the cumulative delta, memory and disk as trapezoids over time, GPU only while
running) and stored in `meter/`. Every 60 s the daemon ships pending batches (at most 500 per request) to
`ControlPaths.meterRecords` with `x-kestrel-meter-host`. Records leave the outbox only after the control plane accepts
them.

## Layout

- `src/cli.ts`: argument parsing, `daemon` and `vm` commands. `src/errors.ts`: the error classes behind exit codes 1 and 2, and `errorMessage`.
- `src/config.ts`: strict config and host secret loading. `src/tools.ts`: executable check on PATH.
- `src/daemon.ts`: wires the manager, control link, local API, meter shipping and shutdown.
- `src/vm-manager.ts`: VM lifecycle, command execution, policy ticks, meter ticks.
- `src/recovery.ts`: what survives a restart, decided from the record and live processes. Pure: the caller observes the facts and carries out the plan.
- `src/control-link.ts`, `src/local-api.ts`: the two network surfaces.
- `src/ch-api.ts`, `src/ch-process.ts`: Cloud Hypervisor API client and process launch (scope or direct).
- `src/vsock.ts`: guest agent link (`CONNECT`/`OK` handshake, newline-delimited JSON, per-line cap).
- `src/template.ts`, `src/restore.ts`: the shared template, and restore with a rewritten config.
- `src/network.ts`: slot allocation, tap and nftables commands, guest addressing.
- `src/policy.ts`: memory and vCPU targets, idle detection, suspend victim choice, disk pressure.
- `src/volume.ts`: `kestrel-volume` service. `src/meter.ts`, `src/outbox.ts`: usage measurement and shipping.
- `src/state-store.ts`, `src/fs-atomic.ts`, `src/lock.ts`: durable state, atomic writes, and per-VM locks.
- `src/proc.ts`: process identity (pid plus kernel start time). `src/schema.ts`: shared Effect schemas.

## Tests

`bun test` in this package runs unit tests for the pure and file-level parts: policy, network allocation, restore
config rewriting, meter usage math, the vsock line framer, command outcomes and the state store, the lock, config
validation, and tool lookup. Behavior
that needs a real VMM, tap devices or the guest agent is covered by the smoke runs described in the PR, not by these
tests.

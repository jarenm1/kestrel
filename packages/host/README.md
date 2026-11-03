# @cloudagents/host (`kestrel-host`)

Local-only, non-production CLI that runs on one Linux host and manages per-user CPU VMs through
`scripts/nest-prototype/run.sh`. Run it with `bun packages/host/src/cli.ts <command>` or the `kestrel-host` bin.

## State directory

`$KESTREL_HOST_HOME`, else `${XDG_STATE_HOME:-$HOME/.local/state}/kestrel-host`.

```
host.json                  {schemaVersion:1, hostId}  created once by `init` (other commands auto-init)
events.jsonl               append-only lifecycle outbox, one fsynced JSON line per record
vms/<vmId>/vm.json         VM record (schemaVersion 1); also the tombstone after destroy
vms/<vmId>/os.raw          copy of the base OS image (reflink when supported)
vms/<vmId>/data.raw        ext4 data volume, label kestrel-data, uuid recorded in vm.json
vms/<vmId>/console.sock    serial console (QEMU chardev, server)
vms/<vmId>/console.log     serial console log
vms/<vmId>/qmp.sock        QMP control socket (wait=off)
vms/<vmId>/launcher.log    stdout/stderr of the detached launcher
vms/<vmId>/lock            per-VM lock: {pid, startTime, token}
```

Every `vm.json` write is atomic (temp file, fsync, rename, directory fsync). `vmId` is a fresh UUID v4 for each
incarnation, so a recreated or moved VM gets a new id.

## State machine

```
stopped    -> starting | destroying
starting   -> running | stopped | stopping
running    -> stopping | stopped
stopping   -> stopped
destroying -> deleted
deleted    -> (terminal)
```

- `sequence` counts state changes only. Field-only updates (`process`, `lastError`) do not change it.
- A stop that times out leaves the VM in `stopping`; running `vm stop` again retries it.
- Known limitation: `stop` sent about 1 s after `start` (guest still booting) did not power the guest off; it timed out at 120 s and stayed `stopping`. A retry after the guest reached login stopped cleanly. Wait for login before stopping.
- `starting -> stopping` lets an operator stop a VM whose launcher is alive but not yet QMP-ready.
- Start verifies the data volume identity with `blkid -p -o export` and refuses on mismatch. It never formats.

## Lifecycle records (`LifecycleRecord` in `@cloudagents/protocol`, schema v1)

`{schemaVersion:1, eventId, hostId, vmId, userId, observedAt (UTC ISO, ms), kind:"lifecycle", state}`,
with `state` one of `running | parked | deleted`. Records are validated strictly (no unknown keys) before writing.

| Event | Record |
| --- | --- |
| start succeeds (QMP answers) | `running` |
| clean stop (QMP powerdown, QEMU exited) | `parked` |
| `--force` stop (QMP quit) | `parked` (vm.json `lastError` notes the forced stop) |
| destroy completes | `deleted` |
| reconcile finds a running/stopping VM whose process is gone | `parked` |
| stop or reconcile of a VM that never reached running (e.g. stopped while `starting`) | no record |
| create, failed start, reconcile of a dead `starting` VM | no record |

No usage records are collected by this host.

## Commands

```
kestrel-host init
kestrel-host vm create --user <userId> --os-image <raw path> [--cpus N=2 (1-8)] [--memory-mb N=2048 (max 4096)] [--volume-gb N=20]
kestrel-host vm start <vmId>
kestrel-host vm stop <vmId> [--timeout SECONDS=120] [--force]
kestrel-host vm destroy <vmId> --yes
kestrel-host vm list
kestrel-host vm show <vmId>
kestrel-host reconcile
```

- `create` copies the OS image (refuses to overwrite), creates `data.raw` (refuses if it exists), and formats it
  with `mkfs.ext4 -L kestrel-data -U <fresh uuid>`. It emits no record.
- `start` spawns the launcher detached with `[os.raw, data.raw]` and the `KESTREL_VM_*` environment. The host never
  holds the image locks. The VM is `running` once QMP answers within 5 s. If the launcher dies first, the VM goes back
  to `stopped` with `launcher.log` tail in `lastError`.
- `stop` sends QMP `system_powerdown` and waits up to `--timeout`. It never kills. On timeout the VM stays `stopping`
  with `lastError` set and the command exits 1. `--force` sends QMP `quit` after the timeout, warns on stderr that
  disk contents may be inconsistent, and records that in `lastError`.
- `destroy` requires `--yes` and a `stopped` VM (or resumes an interrupted destroy). It refuses if the recorded pid
  is still alive. It removes `os.raw`, `data.raw`, sockets, and logs, but keeps `vm.json` (state `deleted`) and the
  lock file as the tombstone.
- `list` and `show` print JSON.
- `reconcile` runs automatically before every command that touches VMs. A `running`/`stopping` VM whose recorded pid
  is gone, or whose `/proc/<pid>/cmdline` no longer names `kestrel-<vmId>`, becomes `stopped` with lastError
  `process gone at reconcile` and a `parked` record. Stale locks are cleared. A live `starting` VM that is not yet
  QMP-ready stays `starting`.

Exit codes: 0 success, 1 operational error (message on stderr), 2 usage error.

## Environment

| Variable | Meaning |
| --- | --- |
| `KESTREL_HOST_HOME` | state directory |
| `XDG_STATE_HOME` | used when `KESTREL_HOST_HOME` is unset |
| `KESTREL_HOST_LAUNCHER` | launcher script (default: repo `scripts/nest-prototype/run.sh`) |
| `KESTREL_VM_ACCEL` | `auto` (default), `kvm`, or `tcg`, passed to the launcher |

## Tests

`bun test packages/host`. The create, start, and stop tests need `mkfs.ext4` on PATH and are skipped without it.
The start and stop tests use a fake launcher and a fake QMP server (`src/test-fake-qemu.ts`), not QEMU.

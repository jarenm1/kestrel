# Nest usage metering (non-billable)

Estimates only. Nothing here is a bill, a charge, or an accounting ledger. Every report is `billable: false`, and a
zero total can mean "no data" as easily as "no use". Rates are supplied by the operator per request; none are built in.

## Pieces

- `collector.ts` runs on a Nest host. Each tick it samples every VM's QEMU process and disks and posts records to the
  control plane with `ControlPaths.meterRecords` (`/api/meter/records`), authenticated by the host secret.
- Control plane (`packages/control`, Hub Durable Object SQLite): stores records idempotently. A resent record with the
  same `eventId` is counted as a duplicate; a reused `eventId` with different content, a host mismatch, or a VM whose
  owner changed is refused.
- `POST /api/meter/report` (operator only) takes a `from` and `through` window of at most 31 days and reconciles the
  stored records inside it against each VM's lifecycle: gaps, overlaps, unexpected usage, lifecycle conflicts,
  coverage, and parked-disk attribution to the owner. Usage straddling a window edge is prorated to the part inside it.
  `from` may be at most 90 days old; records older than that are purged on ingest. Each VM keeps its latest lifecycle
  record before the cutoff, so a window starting after it still knows the VM's state.

## Measurements

| Lifecycle state | Recorded                                                       |
| --------------- | -------------------------------------------------------------- |
| running         | CPU core-seconds, memory byte-seconds, disk byte-seconds, GPU device-seconds (when declared) |
| suspended       | disk byte-seconds                                              |
| parked          | disk byte-seconds (attributed to the owner)                    |
| deleted         | nothing                                                        |

- CPU is the QEMU process's own `utime + stime` from `/proc/<pid>/stat`, not a cgroup. It excludes anything outside
  that process.
- Memory is the process's `VmRSS` at sample time, multiplied by the sampled interval.
- Disk is the allocated size (`st_blocks * 512`) of each listed disk, so sparse holes are not billed.
- Identity is pid plus process start time. A restarted or reused pid starts a new CPU baseline.

## Gaps

A stretch longer than two sampling intervals is not bridged: the collector sends no usage for it, and the report
lists it as a gap. A resource whose process is missing (crashed, or not yet started) is likewise absent rather than
zero. If any listed disk cannot be stat'ed, disk usage for that interval is absent too; the VM's other resources are still
sampled. Usage that straddles a lifecycle transition is attributed to the state the VM held during it, using the sample
at the transition tick. A VM that moves to `deleted` is not sampled at that tick, so its CPU and memory for the interval before deletion are reported as a gap; its disk is still measured.

## Running it

Inventory (`MeterInventory` in `packages/protocol/src/meter.ts`), re-read every tick. `hostId` is the `id` that
`POST /api/meter/hosts` returns (a UUID), not the host name. `gpus` (optional, default 0) is the number of GPUs
the VM holds; GPU time is expected only while it is above zero.

```json
{
  "hostId": "0e15d103-3f96-415a-a5d1-d5abc008bd21",
  "vms": [
    {
      "vmId": "vm-1",
      "userId": "user-1",
      "state": "running",
      "pidFile": "/run/nest/vm-1.pid",
      "disks": ["/srv/nest/vm-1.raw"]
    },
    { "vmId": "vm-2", "userId": "user-1", "state": "parked", "disks": ["/srv/nest/vm-2.raw"] }
  ]
}
```

Create the host as an operator (`POST /api/meter/hosts` with a `{ "name": "host-a" }` body; the secret is returned
once), store the secret in a file readable only by the collector user, then:

```sh
bun scripts/nest-meter/collector.ts --config inventory.json --state-dir ./meter --secret-file host-a.secret \
  --control http://127.0.0.1:8828 --interval 60
```

The state directory holds `vms.json` (per-VM sample baseline), `outbox.jsonl` (records not yet settled, fsynced before
sending), and `rejected.jsonl` (records the control plane refused with a 4xx, and outbox lines that do not decode; review
them, they are not resent). A refused batch is split so that only the refused records land in `rejected.jsonl`. A 5xx,
429, 401, or 403 keeps the outbox and retries the same records with the same `eventId`s.

The outbox holds at most 50,000 records. When it is full, new samples are dropped with a log line and show as gaps. A
flush posts batches and rewrites the outbox once, after the last batch. A crash mid-flush resends records the control
plane already accepted; it counts them as duplicates.

Egress is not measured. It is not implemented.

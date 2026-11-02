#!/usr/bin/env bun
/**
 * Nest usage collector. Runs on a host that runs Nest VMs: each tick it samples every VM's QEMU process (CPU time from
 * /proc/<pid>/stat, resident memory from /proc/<pid>/status) and the allocated blocks of its disks, then posts
 * non-billable usage and lifecycle records to the control plane. Records are appended to a durable outbox before
 * they are sent and are resent with the same eventIds until the control plane answers. A missed sample is never
 * bridged: the next usage record starts where the last sample was taken, and reconciliation reports what is missing.
 *
 *   bun scripts/nest-meter/collector.ts --config inventory.json --state-dir ./meter --secret-file host.secret \
 *     --control http://127.0.0.1:8828 [--interval 60] [--once]
 *
 * The inventory (`MeterInventory` in packages/protocol) is re-read every tick: `{ hostId, vms: [...] }`, where each VM
 * has its lifecycle `state` (running, suspended, parked, deleted), a `pidFile` holding its QEMU pid, and its `disks`.
 */
import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { ControlPaths } from "../../packages/protocol/src/control"
import {
  decodeMeterCollectorState,
  decodeMeterInventory,
  decodeMeterRecord,
  MAX_METER_BATCH,
  METER_HOST_ID_HEADER,
  type MeterCollectorState,
  type MeterInventory,
  type MeterMeasurements,
  type MeterRecord,
} from "../../packages/protocol/src/meter"

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "state-dir": { type: "string" },
    "secret-file": { type: "string" },
    control: { type: "string" },
    interval: { type: "string", default: "60" },
    once: { type: "boolean", default: false },
  },
})

const usage =
  "usage: collector.ts --config <inventory.json> --state-dir <dir> --secret-file <file> " +
  "--control <url> [--interval s] [--once]"
if (!values.config || !values["state-dir"] || !values["secret-file"] || !values.control) {
  console.error(usage)
  process.exit(2)
}
const configPath = values.config
const stateDir = values["state-dir"]
const secretFile = values["secret-file"]
const controlUrl = values.control
const intervalSec = Number(values.interval)
if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
  throw new Error("--interval must be a positive number of seconds")
}

type VmEntry = MeterInventory["vms"][number]
type Saved = MeterCollectorState[string]

const statePath = join(stateDir, "vms.json")
const outboxPath = join(stateDir, "outbox.jsonl")
const rejectedPath = join(stateDir, "rejected.jsonl")

const clockTicks = Number(new TextDecoder().decode(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout).trim())
if (!Number.isInteger(clockTicks) || clockTicks <= 0) throw new Error("getconf CLK_TCK did not return a tick rate")

const fsyncDir = (dir: string) => {
  const fd = openSync(dir, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Appends to `path` and fsyncs before returning. */
const appendDurable = (path: string, data: string) => {
  const fd = openSync(path, "a")
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Replaces `path` atomically: the new content is fsynced under a temporary name, then renamed into place. */
const replaceDurable = (path: string, data: string) => {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, "w")
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDir(dirname(path))
}

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "")

const loadState = (): Record<string, Saved> => {
  const text = readText(statePath)
  return text === "" ? {} : decodeMeterCollectorState(JSON.parse(text))
}

type Live = { identity: string; cpuTicks: number; rssBytes: number }

/**
 * The QEMU process for a VM, or null when it is not running. Identity is pid plus start time, so a reused pid is new.
 */
const sampleProcess = (pidFile: string | undefined): Live | null => {
  if (pidFile === undefined || !existsSync(pidFile)) return null
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // Fields after the parenthesised command name; index 0 is field 3 (state). A zombie has no CPU left to read.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    if (fields[0] === "Z") return null
    const rss = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))
    if (rss === null) return null
    return {
      identity: `${pid}:${fields[19]}`,
      cpuTicks: Number(fields[11]) + Number(fields[12]),
      rssBytes: Number(rss[1]) * 1024,
    }
  } catch {
    return null
  }
}

/** Allocated bytes across `paths`, or null if any is unreadable: a partial sum would read as a measured undercount. */
const allocatedDiskBytes = (paths: readonly string[]): number | null => {
  let total = 0
  for (const path of paths) {
    try {
      total += statSync(path).blocks * 512
    } catch {
      return null
    }
  }
  return total
}

/** Measurements for the interval a VM spent in `prev.state`. A resource that cannot be read is absent, not zero. */
const measure = (vm: VmEntry, prev: Saved, live: Live | null, dtSec: number): MeterMeasurements => {
  const measurements: { -readonly [K in keyof MeterMeasurements]?: number } = {}
  if (vm.disks.length > 0) {
    const allocatedBytes = allocatedDiskBytes(vm.disks)
    if (allocatedBytes === null) {
      console.error(`${vm.vmId}: a disk is unreadable; disk usage not recorded this interval`)
    } else {
      measurements.diskByteSeconds = allocatedBytes * dtSec
    }
  }
  if (prev.state === "running" && live !== null && live.identity === prev.identity && prev.cpuTicks !== null) {
    measurements.cpuCoreSeconds = (live.cpuTicks - prev.cpuTicks) / clockTicks
    measurements.memoryByteSeconds = live.rssBytes * dtSec
    if (prev.gpus > 0) measurements.gpuDeviceSeconds = prev.gpus * dtSec
  }
  return measurements
}

/** One sampling pass: the records to queue, and the state to remember for the next pass. */
const sampleAll = (inventory: MeterInventory, saved: Record<string, Saved>, now: string) => {
  const records: MeterRecord[] = []
  const next: Record<string, Saved> = {}
  for (const vm of inventory.vms) {
    const prev = saved[vm.vmId] as Saved | undefined
    const base = {
      schemaVersion: 1 as const,
      hostId: inventory.hostId,
      vmId: vm.vmId,
      userId: vm.userId,
      observedAt: now,
    }
    const gpus = vm.gpus ?? 0
    if (prev === undefined || prev.state !== vm.state || prev.gpus !== gpus) {
      records.push(decodeMeterRecord({ ...base, eventId: randomUUID(), kind: "lifecycle", state: vm.state, gpus }))
    }
    const live = vm.state === "deleted" ? null : sampleProcess(vm.pidFile)
    // Usage for the interval just ended belongs to the state the VM held during it.
    if (prev !== undefined && prev.state !== "deleted") {
      const dtSec = (Date.parse(now) - Date.parse(prev.sampledAt)) / 1000
      // A stretch longer than two intervals was not sampled; it stays a gap rather than being bridged.
      if (dtSec > 0 && dtSec <= 2 * intervalSec) {
        const measurements = measure(vm, prev, live, dtSec)
        if (Object.keys(measurements).length > 0) {
          records.push(
            decodeMeterRecord({
              ...base,
              eventId: randomUUID(),
              kind: "usage",
              start: prev.sampledAt,
              end: now,
              measurements,
            }),
          )
        }
      }
    }
    next[vm.vmId] =
      vm.state === "deleted"
        ? { state: "deleted", sampledAt: now, identity: null, cpuTicks: null, gpus }
        : {
            state: vm.state,
            sampledAt: now,
            identity: vm.state === "running" ? (live?.identity ?? null) : null,
            cpuTicks: vm.state === "running" ? (live?.cpuTicks ?? null) : null,
            gpus,
          }
  }
  return { records, next }
}

/** Outbox lines that decode as records. A line torn by a crash mid-append goes to rejected.jsonl, so it cannot block the lines after it. */
const readOutbox = (): string[] => {
  const valid: string[] = []
  const invalid: string[] = []
  for (const line of readText(outboxPath).split("\n")) {
    if (line === "") continue
    try {
      decodeMeterRecord(JSON.parse(line))
      valid.push(line)
    } catch {
      invalid.push(line)
    }
  }
  if (invalid.length > 0) {
    appendDurable(rejectedPath, invalid.map((line) => `${line}\n`).join(""))
    replaceDurable(outboxPath, valid.map((line) => `${line}\n`).join(""))
    console.error(`${invalid.length} unreadable outbox line(s) moved to rejected.jsonl`)
  }
  return valid
}

/**
 * Posts `lines` and returns how many leading lines are settled: accepted, or refused and kept in rejected.jsonl. A
 * refused batch is split until each refused record stands alone, so one bad record cannot take its neighbours with it.
 */
const deliver = async (lines: string[], secret: string, hostId: string): Promise<number> => {
  let response: Response
  try {
    response = await fetch(new URL(ControlPaths.meterRecords, controlUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        [METER_HOST_ID_HEADER]: hostId,
      },
      body: JSON.stringify({ records: lines.map((line) => JSON.parse(line)) }),
    })
  } catch (error) {
    console.error(`post failed, ${lines.length} record(s) kept for retry: ${String(error)}`)
    return 0
  }
  // Server errors, rate limits, and rejected credentials are not about the records: keep them for retry.
  if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
    console.error(`control answered ${response.status}, ${lines.length} record(s) kept for retry`)
    return 0
  }
  if (response.ok) return lines.length
  if (lines.length === 1) {
    appendDurable(rejectedPath, `${lines[0]}\n`)
    console.error(`control refused a record with ${response.status}; kept in rejected.jsonl`)
    return 1
  }
  const half = Math.ceil(lines.length / 2)
  const first = await deliver(lines.slice(0, half), secret, hostId)
  if (first < half) return first
  return first + (await deliver(lines.slice(half), secret, hostId))
}

/** Most records the outbox holds. Samples beyond it are dropped, and the report shows them as gaps. */
const MAX_OUTBOX_RECORDS = 50_000

/**
 * Posts `pending` in batches and returns the lines still unsettled, stopping at the first retryable failure. The outbox
 * is rewritten once, after the last batch. A crash before that resends settled lines, which the control plane
 * acknowledges as duplicates.
 */
const flush = async (pending: string[], secret: string, hostId: string): Promise<string[]> => {
  let settled = 0
  while (settled < pending.length) {
    const batch = pending.slice(settled, settled + MAX_METER_BATCH)
    const done = await deliver(batch, secret, hostId)
    settled += done
    if (done < batch.length) break
  }
  if (settled > 0) replaceDurable(outboxPath, pending.slice(settled).map((line) => `${line}\n`).join(""))
  return pending.slice(settled)
}

const tick = async (secret: string) => {
  const now = new Date().toISOString()
  const inventory = decodeMeterInventory(JSON.parse(readFileSync(configPath, "utf8")))
  // Repairs a line torn by an earlier crash before anything is appended after it.
  const queued = readOutbox()
  const { records, next } = sampleAll(inventory, loadState(), now)
  const kept = records.slice(0, Math.max(MAX_OUTBOX_RECORDS - queued.length, 0))
  if (kept.length < records.length) {
    console.error(`outbox holds ${MAX_OUTBOX_RECORDS} record(s); ${records.length - kept.length} sample(s) dropped`)
  }
  const lines = kept.map((record) => JSON.stringify(record))
  // The outbox is durable before the state moves on: a crash between the two resends records, never loses them.
  if (lines.length > 0) appendDurable(outboxPath, lines.map((line) => `${line}\n`).join(""))
  replaceDurable(statePath, JSON.stringify(next))
  const left = await flush([...queued, ...lines], secret, inventory.hostId)
  console.log(`${now} sampled ${inventory.vms.length} VM(s), queued ${lines.length}, outbox ${left.length}`)
}

mkdirSync(stateDir, { recursive: true })
const secret = readFileSync(secretFile, "utf8").trim()
if (values.once) {
  await tick(secret)
} else {
  for (;;) {
    try {
      await tick(secret)
    } catch (error) {
      console.error(`tick failed: ${String(error)}`)
    }
    await Bun.sleep(intervalSec * 1000)
  }
}

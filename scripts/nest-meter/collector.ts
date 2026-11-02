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

/** Measurements for the interval a VM spent in `prev.state`. A resource that cannot be read is absent, not zero. */
const measure = (vm: VmEntry, prev: Saved, live: Live | null, dtSec: number): MeterMeasurements => {
  const measurements: { -readonly [K in keyof MeterMeasurements]?: number } = {}
  if (vm.disks.length > 0) {
    const allocatedBytes = vm.disks.reduce((sum, path) => sum + statSync(path).blocks * 512, 0)
    measurements.diskByteSeconds = allocatedBytes * dtSec
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

const readOutbox = (): string[] => readText(outboxPath).split("\n").filter((line) => line !== "")

/** Posts the outbox in batches, dropping what the control plane accepted. Stops at the first retryable failure. */
const flush = async (secret: string, hostId: string) => {
  let pending = readOutbox()
  while (pending.length > 0) {
    const batch = pending.slice(0, MAX_METER_BATCH)
    let response: Response
    try {
      response = await fetch(new URL(ControlPaths.meterRecords, controlUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
          [METER_HOST_ID_HEADER]: hostId,
        },
        body: JSON.stringify({ records: batch.map((line) => JSON.parse(line)) }),
      })
    } catch (error) {
      console.error(`post failed, ${pending.length} record(s) kept for retry: ${String(error)}`)
      return
    }
    // Server errors, rate limits, and rejected credentials are not about the records: keep them for retry.
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
      console.error(`control answered ${response.status}, ${pending.length} record(s) kept for retry`)
      return
    }
    if (!response.ok) {
      appendDurable(rejectedPath, batch.map((line) => `${line}\n`).join(""))
      console.error(`control refused ${batch.length} record(s) with ${response.status}; kept in rejected.jsonl`)
    }
    pending = pending.slice(batch.length)
    replaceDurable(outboxPath, pending.map((line) => `${line}\n`).join(""))
  }
}

const tick = async (secret: string) => {
  const now = new Date().toISOString()
  const inventory = decodeMeterInventory(JSON.parse(readFileSync(configPath, "utf8")))
  const { records, next } = sampleAll(inventory, loadState(), now)
  // The outbox is durable before the state moves on: a crash between the two resends records, never loses them.
  if (records.length > 0) appendDurable(outboxPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""))
  replaceDurable(statePath, JSON.stringify(next))
  await flush(secret, inventory.hostId)
  console.log(`${now} sampled ${inventory.vms.length} VM(s), queued ${records.length}, outbox ${readOutbox().length}`)
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

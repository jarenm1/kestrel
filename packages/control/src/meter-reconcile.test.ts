import { describe, expect, test } from "bun:test"
import type { LifecycleRecord, MeterRecord, UsageRecord } from "@cloudagents/protocol"
import { reconcileMeter } from "./meter-reconcile"

const T0 = "2026-01-01T00:00:00.000Z"
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString()

const lifecycle = (
  eventId: string,
  minute: number,
  state: LifecycleRecord["state"],
  gpus?: number,
): LifecycleRecord => ({
  schemaVersion: 1,
  kind: "lifecycle",
  eventId,
  hostId: "host-a",
  vmId: "vm-1",
  userId: "alice",
  observedAt: at(minute),
  state,
  gpus,
})

const usage = (
  eventId: string,
  startMinute: number,
  endMinute: number,
  measurements: UsageRecord["measurements"],
): UsageRecord => ({
  schemaVersion: 1,
  kind: "usage",
  eventId,
  hostId: "host-a",
  vmId: "vm-1",
  userId: "alice",
  observedAt: at(endMinute),
  start: at(startMinute),
  end: at(endMinute),
  measurements,
})

const reconcile = (records: MeterRecord[], through = at(3)) => reconcileMeter(records, { from: T0, through })

const findings = (vm: { findings: { kind: string; resource?: string }[] }, kind: string, resource?: string) =>
  vm.findings.filter((f) => f.kind === kind && (resource === undefined || f.resource === resource))

describe("meter reconciliation", () => {
  test("a running VM with every resource reported for its whole lifecycle reconciles", () => {
    const all = { cpuCoreSeconds: 60, memoryByteSeconds: 600, diskByteSeconds: 600 }
    const report = reconcile([
      lifecycle("l1", 0, "running"),
      usage("u1", 0, 1, all),
      usage("u2", 1, 2, all),
      usage("u3", 2, 3, all),
    ])
    expect(report.billable).toBe(false)
    expect(report.vms[0]).toMatchObject({ status: "reconciled", findings: [] })
    expect(report.vms[0]?.totals.cpuCoreSeconds).toBe(180)
  })

  test("a missing CPU stretch while running is a gap, and the other resources still reconcile", () => {
    const all = { memoryByteSeconds: 60, diskByteSeconds: 60, gpuDeviceSeconds: 0 }
    const report = reconcile([
      lifecycle("l1", 0, "running"),
      usage("u1", 0, 1, { cpuCoreSeconds: 60, ...all }),
      usage("u2", 2, 3, { cpuCoreSeconds: 60, ...all }),
    ])
    const vm = report.vms[0]
    expect(vm).toBeDefined()
    if (vm === undefined) return
    expect(vm.status).toBe("findings")
    const cpuGaps = findings(vm, "gap", "cpuCoreSeconds")
    expect(cpuGaps).toHaveLength(1)
    expect(cpuGaps[0]).toMatchObject({ start: at(1), end: at(2) })
    expect(vm.coverage.cpuCoreSeconds.missingSeconds).toBe(60)
  })

  test("two usage records claiming the same time are an overlap", () => {
    const cpu = { cpuCoreSeconds: 60 }
    const report = reconcile([lifecycle("l1", 0, "running"), usage("u1", 0, 2, cpu), usage("u2", 1, 3, cpu)])
    const vm = report.vms[0]
    if (vm === undefined) throw new Error("no VM report")
    const overlaps = findings(vm, "overlap", "cpuCoreSeconds")
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]).toMatchObject({ start: at(1), end: at(2) })
  })

  test("disk used while parked is attributed to parked time, in proportion to the interval", () => {
    const report = reconcile([
      lifecycle("l1", 0, "running"),
      lifecycle("l2", 1, "parked"),
      usage("u1", 0, 3, { diskByteSeconds: 300 }),
    ])
    const vm = report.vms[0]
    expect(vm?.parkedDiskByteSeconds).toBeCloseTo(200)
    expect(report.users[0]?.parkedDiskByteSeconds).toBeCloseTo(200)
  })

  test("a deleted VM that still reports usage is unexpected usage", () => {
    const report = reconcile([
      lifecycle("l1", 0, "running"),
      lifecycle("l2", 1, "deleted"),
      usage("u1", 0, 1, { cpuCoreSeconds: 60, memoryByteSeconds: 60, diskByteSeconds: 60, gpuDeviceSeconds: 0 }),
      usage("u2", 1, 2, { cpuCoreSeconds: 60 }),
    ])
    const vm = report.vms[0]
    if (vm === undefined) throw new Error("no VM report")
    expect(findings(vm, "unexpected-usage", "cpuCoreSeconds")).toHaveLength(1)
  })

  test("a lifecycle event after deletion is a lifecycle conflict", () => {
    const report = reconcile([lifecycle("l1", 0, "deleted"), lifecycle("l2", 1, "running")])
    const vm = report.vms[0]
    if (vm === undefined) throw new Error("no VM report")
    expect(vm.findings.some((f) => f.kind === "lifecycle-conflict")).toBe(true)
  })

  test("usage straddling `through` is prorated to the window", () => {
    const report = reconcile([lifecycle("l1", 0, "running"), usage("u1", 0, 5, { cpuCoreSeconds: 300 })], at(2))
    expect(report.vms[0]?.totals.cpuCoreSeconds).toBe(120)
    expect(report.records).toBe(2)
  })

  test("with rates, the report carries an estimated cost; without, none", () => {
    const rates = { cpuCoreSeconds: 0.5, memoryByteSeconds: 0, diskByteSeconds: 0, gpuDeviceSeconds: 0 }
    const records: MeterRecord[] = [lifecycle("l1", 0, "running"), usage("u1", 0, 1, { cpuCoreSeconds: 60 })]
    const priced = reconcileMeter(records, { from: T0, through: at(1), rates, currency: "USD" })
    expect(priced.currency).toBe("USD")
    expect(priced.estimatedCost).toBeCloseTo(30)
    expect(priced.users[0]?.estimatedCost).toBeCloseTo(30)
    const unpriced = reconcileMeter(records, { from: T0, through: at(1) })
    expect(unpriced.estimatedCost).toBeUndefined()
  })

  test("GPU time is expected only while the VM holds GPUs", () => {
    const cpu = { cpuCoreSeconds: 60, memoryByteSeconds: 600, diskByteSeconds: 600 }
    const noGpus = reconcile([
      lifecycle("l1", 0, "running"),
      usage("u1", 0, 1, cpu),
      usage("u2", 1, 2, cpu),
      usage("u3", 2, 3, cpu),
    ])
    expect(noGpus.vms[0]).toMatchObject({ status: "reconciled", findings: [] })
    const oneGpu = reconcile([
      lifecycle("l1", 0, "running", 1),
      usage("u1", 0, 1, cpu),
      usage("u2", 1, 2, cpu),
      usage("u3", 2, 3, cpu),
    ])
    expect(oneGpu.vms[0]?.findings).toEqual([
      {
        kind: "gap",
        resource: "gpuDeviceSeconds",
        start: at(0),
        end: at(3),
        detail: "gpuDeviceSeconds not reported while the lifecycle expects it",
      },
    ])
  })

  test("a VM running since before the window carries its state in and prorates usage straddling its start", () => {
    const report = reconcileMeter(
      [
        lifecycle("l0", -5, "running"),
        usage("u1", -1, 1, { cpuCoreSeconds: 120 }),
        usage("u2", 1, 2, { cpuCoreSeconds: 60 }),
      ],
      { from: at(0), through: at(2) },
    )
    expect(report.vms[0]?.totals.cpuCoreSeconds).toBe(120)
    expect(report.vms[0]?.findings.filter((f) => f.resource === "cpuCoreSeconds")).toEqual([])
  })

  test("a VM deleted before the window has nothing to report and is left out", () => {
    const report = reconcileMeter([lifecycle("l0", -5, "deleted")], { from: at(0), through: at(2) })
    expect(report.vms).toEqual([])
    expect(report.users).toEqual([])
  })
})

/**
 * Reconciles stored Nest usage records with each VM's lifecycle into a non-billable report. Pure: the Hub hands it the
 * stored records and the window to check. Inconsistent input becomes a finding, never an exception, so a report always
 * says what is missing rather than hiding it.
 */
import {
  METER_RESOURCES,
  type LifecycleRecord,
  type MeterFinding,
  type MeterRates,
  type MeterRecord,
  type MeterReport,
  type MeterResource,
  type MeterState,
  type MeterUserReport,
  type MeterVmReport,
  type UsageRecord,
} from "@cloudagents/protocol"

/** A half-open interval in epoch milliseconds. */
type Span = { start: number; end: number }

type Amounts = Record<MeterResource, number>

/**
 * Which resources a VM in each state is expected to report. Parked and suspended VMs keep only their disks. GPU time is
 * expected only while the VM holds GPUs.
 */
const EXPECTED: Record<MeterState, readonly MeterResource[]> = {
  running: METER_RESOURCES,
  suspended: ["diskByteSeconds"],
  parked: ["diskByteSeconds"],
  deleted: [],
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** Sorted, with overlapping and touching spans merged. */
const union = (spans: readonly Span[]): Span[] => {
  const out: Span[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.end <= span.start) continue
    const last = out[out.length - 1]
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else out.push({ start: span.start, end: span.end })
  }
  return out
}

/** The parts of `a` not covered by `b`. Both must be unions. */
const subtract = (a: readonly Span[], b: readonly Span[]): Span[] => {
  const out: Span[] = []
  for (const span of a) {
    let start = span.start
    for (const cut of b) {
      if (cut.end <= start) continue
      if (cut.start >= span.end) break
      if (cut.start > start) out.push({ start, end: cut.start })
      start = Math.max(start, cut.end)
      if (start >= span.end) break
    }
    if (start < span.end) out.push({ start, end: span.end })
  }
  return out
}

/** The time both unions cover: what `a` and `b` share. */
const intersect = (a: readonly Span[], b: readonly Span[]): Span[] => subtract(a, subtract(a, b))

const measure = (spans: readonly Span[]): number => spans.reduce((sum, s) => sum + (s.end - s.start), 0)

/**
 * Where a resource's usage spans claim the same time: one span per overlap, found against the furthest-reaching
 * span.
 */
const overlapsOf = (reported: readonly Span[]): Span[] => {
  const out: Span[] = []
  let furthest: Span | undefined
  for (const span of [...reported].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (furthest !== undefined && span.start < furthest.end) {
      out.push({ start: span.start, end: Math.min(span.end, furthest.end) })
    }
    if (furthest === undefined || span.end > furthest.end) furthest = span
  }
  return out
}

/** A stretch of time inside the window in which the lifecycle holds one state. */
type Segment = Span & { state: MeterState; gpus: number }

/**
 * Each lifecycle event holds its state until the next event, or until `through`. Events before `from` only set the
 * state at `from`; findings come from events inside the window alone.
 */
const lifecycleSegments = (
  events: readonly LifecycleRecord[],
  from: number,
  through: number,
  findings: MeterFinding[],
): Segment[] => {
  const segments: Segment[] = []
  events.forEach((event, i) => {
    const at = Date.parse(event.observedAt)
    const inside = at >= from
    const previous = events[i - 1]
    const next = events[i + 1]
    if (inside && previous?.state === "deleted" && event.state !== "deleted") {
      findings.push({
        kind: "lifecycle-conflict",
        start: iso(at),
        end: iso(at),
        detail: `${event.state} after deleted`,
      })
    }
    if (inside && next !== undefined && Date.parse(next.observedAt) === at && next.state !== event.state) {
      const detail = `${event.state} and ${next.state} recorded at the same instant`
      findings.push({ kind: "lifecycle-conflict", start: iso(at), end: iso(at), detail })
    }
    const end = Math.min(next === undefined ? through : Date.parse(next.observedAt), through)
    const start = Math.max(at, from)
    if (start < end) segments.push({ state: event.state, gpus: event.gpus ?? 0, start, end })
  })
  return segments
}

const reconcileVm = (vmId: string, records: readonly MeterRecord[], from: number, through: number): MeterVmReport => {
  const findings: MeterFinding[] = []
  const lifecycle = records
    .filter((r): r is LifecycleRecord => r.kind === "lifecycle")
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || (a.eventId < b.eventId ? -1 : 1))
  const usage = records.filter((r): r is UsageRecord => r.kind === "usage")
  const segments = lifecycleSegments(lifecycle, from, through, findings)
  const parked = union(segments.filter((s) => s.state === "parked"))

  const totals: Amounts = { cpuCoreSeconds: 0, memoryByteSeconds: 0, diskByteSeconds: 0, gpuDeviceSeconds: 0 }
  const reported = {} as Record<MeterResource, Span[]>
  let parkedDiskByteSeconds = 0
  for (const res of METER_RESOURCES) reported[res] = []
  for (const record of usage) {
    const duration = Date.parse(record.end) - Date.parse(record.start)
    const span = { start: Math.max(Date.parse(record.start), from), end: Math.min(Date.parse(record.end), through) }
    if (span.end <= span.start) continue
    const share = (span.end - span.start) / duration
    for (const res of METER_RESOURCES) {
      const amount = record.measurements[res]
      if (amount === undefined) continue
      totals[res] += amount * share
      reported[res].push(span)
      if (res === "diskByteSeconds") {
        const inParked = measure(intersect([span], parked))
        parkedDiskByteSeconds += (amount * inParked) / duration
      }
    }
  }

  const coverage = {} as Record<MeterResource, { observedSeconds: number; missingSeconds: number }>
  for (const res of METER_RESOURCES) {
    const expected = union(
      segments.filter((s) => EXPECTED[s.state].includes(res) && (res !== "gpuDeviceSeconds" || s.gpus > 0)),
    )
    const spans = union(reported[res])
    for (const overlap of overlapsOf(reported[res])) {
      const detail = `two usage records claim ${res} for this time`
      findings.push({ kind: "overlap", resource: res, start: iso(overlap.start), end: iso(overlap.end), detail })
    }
    for (const gap of subtract(expected, spans)) {
      const detail = `${res} not reported while the lifecycle expects it`
      findings.push({ kind: "gap", resource: res, start: iso(gap.start), end: iso(gap.end), detail })
    }
    for (const extra of subtract(spans, expected)) {
      const detail =
        lifecycle.length === 0
          ? "usage with no lifecycle record"
          : `${res} reported where the lifecycle does not expect it`
      findings.push({ kind: "unexpected-usage", resource: res, start: iso(extra.start), end: iso(extra.end), detail })
    }
    coverage[res] = {
      observedSeconds: measure(intersect(spans, expected)) / 1000,
      missingSeconds: measure(subtract(expected, spans)) / 1000,
    }
  }

  const owner = lifecycle[0] ?? usage[0]
  if (owner === undefined) throw new Error(`no records for VM ${vmId}`)
  findings.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      a.kind.localeCompare(b.kind) ||
      (a.resource ?? "").localeCompare(b.resource ?? ""),
  )
  return {
    vmId,
    userId: owner.userId,
    hostIds: [...new Set(records.map((r) => r.hostId))].sort(),
    status: findings.length === 0 ? "reconciled" : "findings",
    totals,
    coverage,
    parkedDiskByteSeconds,
    findings,
  }
}

/** Only a deleted state that ended before `from`: such a VM has nothing in the window to report. */
const isDeletedBefore = (record: MeterRecord, from: number): boolean =>
  record.kind === "lifecycle" && record.state === "deleted" && Date.parse(record.observedAt) < from

/**
 * The estimate for `[from, through)`, from the records `meterRecordsInWindow` reads. Usage is prorated to the part
 * inside the window, and lifecycle findings come only from events inside it. A VM whose only record is a deleted state
 * from before `from` is left out. `rates` (hypothetical, per raw unit) add an `estimatedCost` in `currency`; without
 * them there is no cost.
 */
export const reconcileMeter = (
  records: readonly MeterRecord[],
  options: { from: string; through: string; rates?: MeterRates; currency?: string },
): MeterReport => {
  const { rates } = options
  const from = Date.parse(options.from)
  const through = Date.parse(options.through)
  const byVm = new Map<string, MeterRecord[]>()
  for (const record of records) {
    const group = byVm.get(record.vmId) ?? []
    group.push(record)
    byVm.set(record.vmId, group)
  }
  const vms = [...byVm.keys()]
    .sort()
    .filter((vmId) => !(byVm.get(vmId) ?? []).every((r) => isDeletedBefore(r, from)))
    .map((vmId) => reconcileVm(vmId, byVm.get(vmId) ?? [], from, through))

  const users = new Map<string, { vms: number; totals: Amounts; parkedDiskByteSeconds: number }>()
  for (const vm of vms) {
    const user = users.get(vm.userId) ?? {
      vms: 0,
      totals: { cpuCoreSeconds: 0, memoryByteSeconds: 0, diskByteSeconds: 0, gpuDeviceSeconds: 0 },
      parkedDiskByteSeconds: 0,
    }
    user.vms += 1
    for (const res of METER_RESOURCES) user.totals[res] += vm.totals[res]
    user.parkedDiskByteSeconds += vm.parkedDiskByteSeconds
    users.set(vm.userId, user)
  }
  const userReports: MeterUserReport[] = [...users.keys()].sort().map((userId) => {
    const user = users.get(userId) ?? { vms: 0, totals: {} as Amounts, parkedDiskByteSeconds: 0 }
    const estimatedCost =
      rates === undefined ? undefined : METER_RESOURCES.reduce((sum, res) => sum + user.totals[res] * rates[res], 0)
    return {
      userId,
      vms: user.vms,
      totals: user.totals,
      parkedDiskByteSeconds: user.parkedDiskByteSeconds,
      ...(estimatedCost === undefined ? {} : { estimatedCost }),
    }
  })
  const estimatedCost =
    rates === undefined ? undefined : userReports.reduce((sum, u) => sum + (u.estimatedCost ?? 0), 0)
  return {
    billable: false,
    scope: "recorded-intervals-only",
    from: options.from,
    through: options.through,
    records: records.length,
    ...(options.currency === undefined ? {} : { currency: options.currency }),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    users: userReports,
    vms,
  }
}

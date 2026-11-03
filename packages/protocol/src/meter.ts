/**
 * Usage records from Nest hosts and the operator's reconciled, non-billable report. A host posts immutable records
 * with `ControlPaths.meterRecords`; the control plane stores them idempotently and reconciles them against each VM's
 * lifecycle. Nothing here is a bill: every report is `billable: false`.
 */
import { Schema } from "effect"
import { BoxName } from "./control"

/** Resources a usage record can measure. A missing measurement means unknown, never zero. */
export const MeterResource = Schema.Literal(
  "cpuCoreSeconds",
  "memoryByteSeconds",
  "diskByteSeconds",
  "gpuDeviceSeconds",
)
export type MeterResource = typeof MeterResource.Type
export const METER_RESOURCES: readonly MeterResource[] = MeterResource.literals

/** Header naming the host on `ControlPaths.meterRecords`, with `Authorization: Bearer <host secret>`. */
export const METER_HOST_ID_HEADER = "x-kestrel-meter-host"

/** Records per POST to `ControlPaths.meterRecords`. */
export const MAX_METER_BATCH = 500

/** Largest body `ControlPaths.meterRecords` reads. A full batch of records is well under it. */
export const MAX_METER_BODY_BYTES = 1024 * 1024

/** The widest window a report covers. */
export const MAX_METER_REPORT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

const MeterId = Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(200))

/** A UTC timestamp with milliseconds, as `Date.toISOString` writes it. */
export const MeterTimestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  Schema.filter((value) =>
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? true : "not a valid UTC timestamp",
  ),
)

const Amount = Schema.Number.pipe(Schema.finite(), Schema.nonNegative())
const GpuCount = Schema.Number.pipe(Schema.int(), Schema.nonNegative())

export const MeterState = Schema.Literal("running", "suspended", "parked", "deleted")
export type MeterState = typeof MeterState.Type

const envelope = {
  schemaVersion: Schema.Literal(1),
  /** Unique within `hostId`. A retry repeats the same eventId and payload. */
  eventId: MeterId,
  hostId: MeterId,
  /** A VM incarnation. A VM recreated or moved to a new incarnation gets a new id. */
  vmId: MeterId,
  userId: MeterId,
  observedAt: MeterTimestamp,
}

/** The VM entered `state` at `observedAt`. Informational only: usage is never inferred from it. */
export const LifecycleRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("lifecycle"),
  state: MeterState,
  /** GPUs the VM holds in this state; absent means none. GPU usage is expected only while this is above zero. */
  gpus: Schema.optional(GpuCount),
})
export type LifecycleRecord = typeof LifecycleRecord.Type

/** Integrals over the half-open interval `[start, end)`. Each present measurement is a nonnegative finite number. */
export const MeterMeasurements = Schema.Struct({
  cpuCoreSeconds: Schema.optional(Amount),
  memoryByteSeconds: Schema.optional(Amount),
  diskByteSeconds: Schema.optional(Amount),
  gpuDeviceSeconds: Schema.optional(Amount),
}).pipe(Schema.filter((m) => Object.keys(m).length > 0 || "measurements must include at least one resource"))
export type MeterMeasurements = typeof MeterMeasurements.Type

export const UsageRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("usage"),
  start: MeterTimestamp,
  end: MeterTimestamp,
  measurements: MeterMeasurements,
}).pipe(
  Schema.filter((r) => {
    if (Date.parse(r.start) >= Date.parse(r.end)) return "start must be before end"
    if (Date.parse(r.end) > Date.parse(r.observedAt)) return "end must not be after observedAt"
    return true
  }),
)
export type UsageRecord = typeof UsageRecord.Type

export const MeterRecord = Schema.Union(LifecycleRecord, UsageRecord)
export type MeterRecord = typeof MeterRecord.Type

export const MeterBatch = Schema.Struct({
  records: Schema.Array(MeterRecord).pipe(Schema.minItems(1), Schema.maxItems(MAX_METER_BATCH)),
})
export type MeterBatch = typeof MeterBatch.Type

/** Records newly stored, and identical records already stored (a retry). Both are acknowledged. */
export const MeterIngestResult = Schema.Struct({
  accepted: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  duplicates: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})
export type MeterIngestResult = typeof MeterIngestResult.Type

/** A Nest host that reports usage. Its secret is shown only when created. */
export const MeterHost = Schema.Struct({
  id: Schema.String,
  name: BoxName,
  createdAt: Schema.String,
})
export type MeterHost = typeof MeterHost.Type

export const MeterHostList = Schema.Struct({ hosts: Schema.Array(MeterHost) })
export type MeterHostList = typeof MeterHostList.Type

export const CreateMeterHostBody = Schema.Struct({ name: BoxName })
export type CreateMeterHostBody = typeof CreateMeterHostBody.Type

export const CreatedMeterHost = Schema.Struct({ host: MeterHost, secret: Schema.String })
export type CreatedMeterHost = typeof CreatedMeterHost.Type

/** Hypothetical price per raw unit of each resource. Supplied by the operator; no rates are built in. */
export const MeterRates = Schema.Struct({
  cpuCoreSeconds: Amount,
  memoryByteSeconds: Amount,
  diskByteSeconds: Amount,
  gpuDeviceSeconds: Amount,
})
export type MeterRates = typeof MeterRates.Type

/**
 * The window `[from, through)` a report covers, at most 31 days; records outside it are not read. A VM's lifecycle
 * state at `from` is its latest lifecycle record before `from`. `rates` and `currency` go together; with them the
 * report includes an estimated cost in that currency label.
 */
export const MeterReportBody = Schema.Struct({
  from: MeterTimestamp,
  through: MeterTimestamp,
  rates: Schema.optional(MeterRates),
  currency: Schema.optional(MeterId),
}).pipe(
  Schema.filter((b) => Date.parse(b.from) < Date.parse(b.through) || "from must be before through"),
  Schema.filter(
    (b) => Date.parse(b.through) - Date.parse(b.from) <= MAX_METER_REPORT_WINDOW_MS || "the window may be at most 31 days",
  ),
  Schema.filter((b) => (b.rates === undefined) === (b.currency === undefined) || "rates and currency go together"),
)
export type MeterReportBody = typeof MeterReportBody.Type

/**
 * `gap`: the lifecycle expects this resource and no usage covers it. `overlap`: two usage records claim the same time
 * for a resource. `unexpected-usage`: usage the lifecycle does not expect (or no lifecycle at all).
 * `lifecycle-conflict`: two different states at one instant, or a live state after `deleted` (`start` equals `end`).
 */
export const MeterFinding = Schema.Struct({
  kind: Schema.Literal("gap", "overlap", "unexpected-usage", "lifecycle-conflict"),
  resource: Schema.optional(MeterResource),
  start: MeterTimestamp,
  end: MeterTimestamp,
  detail: Schema.String,
})
export type MeterFinding = typeof MeterFinding.Type

export const MeterCoverage = Schema.Struct({
  observedSeconds: Amount,
  missingSeconds: Amount,
})
export type MeterCoverage = typeof MeterCoverage.Type

const MeterTotals = Schema.Struct({
  cpuCoreSeconds: Amount,
  memoryByteSeconds: Amount,
  diskByteSeconds: Amount,
  gpuDeviceSeconds: Amount,
})

export const MeterVmReport = Schema.Struct({
  vmId: MeterId,
  userId: MeterId,
  hostIds: Schema.Array(MeterId),
  /** `reconciled` when no findings; otherwise its totals cannot be trusted as complete. */
  status: Schema.Literal("reconciled", "findings"),
  /** Measured use inside the window: usage is prorated to the part of it that overlaps the window. */
  totals: MeterTotals,
  /** Expected-by-lifecycle seconds observed and missing, per resource. */
  coverage: Schema.Struct({
    cpuCoreSeconds: MeterCoverage,
    memoryByteSeconds: MeterCoverage,
    diskByteSeconds: MeterCoverage,
    gpuDeviceSeconds: MeterCoverage,
  }),
  /** The part of `diskByteSeconds` reported while the VM was `parked`: its retained data disks, owned by `userId`. */
  parkedDiskByteSeconds: Amount,
  findings: Schema.Array(MeterFinding),
})
export type MeterVmReport = typeof MeterVmReport.Type

export const MeterUserReport = Schema.Struct({
  userId: MeterId,
  vms: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  totals: MeterTotals,
  parkedDiskByteSeconds: Amount,
  estimatedCost: Schema.optional(Schema.Number.pipe(Schema.finite())),
})
export type MeterUserReport = typeof MeterUserReport.Type

export const MeterReport = Schema.Struct({
  billable: Schema.Literal(false),
  scope: Schema.Literal("recorded-intervals-only"),
  from: MeterTimestamp,
  through: MeterTimestamp,
  records: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  currency: Schema.optional(MeterId),
  estimatedCost: Schema.optional(Schema.Number.pipe(Schema.finite())),
  users: Schema.Array(MeterUserReport),
  vms: Schema.Array(MeterVmReport),
})
export type MeterReport = typeof MeterReport.Type

/** A host's inventory for the collector: the VMs it runs, each one's lifecycle state, and where its usage shows. */
export const MeterInventory = Schema.Struct({
  hostId: MeterId,
  vms: Schema.Array(
    Schema.Struct({
      vmId: MeterId,
      userId: MeterId,
      state: MeterState,
      pidFile: Schema.optional(Schema.String),
      disks: Schema.Array(Schema.String),
      gpus: Schema.optional(GpuCount),
    }),
  ),
})
export type MeterInventory = typeof MeterInventory.Type

/** What the collector keeps per VM between samples: the interval since the last sample starts at `sampledAt`. */
export const MeterCollectorState = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({
    state: MeterState,
    sampledAt: MeterTimestamp,
    identity: Schema.NullOr(Schema.String),
    cpuTicks: Schema.NullOr(Schema.Number),
    gpus: GpuCount,
  }),
})
export type MeterCollectorState = typeof MeterCollectorState.Type

export const decodeMeterInventory = Schema.decodeUnknownSync(MeterInventory)
export const decodeMeterCollectorState = Schema.decodeUnknownSync(MeterCollectorState)
export const decodeMeterRecord = Schema.decodeUnknownSync(MeterRecord)

import { randomUUID } from "node:crypto"
import { LifecycleRecord, type MeterState } from "@cloudagents/protocol"
import { Schema } from "effect"
import { HostError } from "./errors"
import { appendLineDurable } from "./fs-atomic"
import { eventsPath } from "./state-store"
import { STRICT } from "./schema"

/**
 * Lifecycle records for the usage meter (`LifecycleRecord` in `@cloudagents/protocol`, schema v1). Only lifecycle
 * records are written here; usage is not collected by this host. Mapping: start succeeds -> running; clean stop or
 * unexpected exit found by reconcile -> parked, but only if a running record is open (vm.runningReported);
 * destroy -> deleted. CPU VMs hold no GPU, so `gpus` is omitted.
 */

/** The lifecycle states this host emits; it never suspends a VM. */
export type HostLifecycleState = Extract<MeterState, "running" | "parked" | "deleted">

export interface LifecycleInput {
  readonly hostId: string
  readonly vmId: string
  readonly userId: string
  readonly state: HostLifecycleState
  readonly observedAt?: string
  readonly eventId?: string
}

/** Builds and strictly validates a lifecycle record. Throws if any field is invalid. */
export const buildLifecycleRecord = (input: LifecycleInput): LifecycleRecord => {
  const candidate = {
    schemaVersion: 1,
    eventId: input.eventId ?? randomUUID(),
    hostId: input.hostId,
    vmId: input.vmId,
    userId: input.userId,
    observedAt: input.observedAt ?? new Date().toISOString(),
    kind: "lifecycle",
    state: input.state,
  }
  return Schema.decodeUnknownSync(LifecycleRecord, STRICT)(candidate)
}

/** Strict validation of an arbitrary value as a lifecycle record. Rejects unknown keys and bad timestamps. */
export const validateLifecycleRecord = (value: unknown): LifecycleRecord =>
  Schema.decodeUnknownSync(LifecycleRecord, STRICT)(value)

/** Validates, then appends one fsynced line to events.jsonl. */
export const appendLifecycleEvent = (stateDir: string, record: LifecycleRecord): void => {
  const valid = validateLifecycleRecord(record)
  try {
    appendLineDurable(eventsPath(stateDir), JSON.stringify(valid))
  } catch (error) {
    throw new HostError(`cannot append lifecycle event: ${(error as Error).message}`)
  }
}

import { HostError } from "./errors"
import type { ProcessRef, VmRecord, VmState } from "./schema"

/**
 * VM state machine. Every change of `state` goes through transitionVm, which bumps `sequence`.
 * Field-only updates (process, lastError) go through updateVm and never change `state` or `sequence`.
 *
 *   stopped   -> starting | stopping | destroying
 *   starting  -> running | stopped | stopping
 *   running   -> stopping | stopped
 *   stopping  -> stopped
 *   destroying -> deleted
 *   deleted   -> (terminal)
 *
 * `stopping -> stopped` is the only way out of stopping; a stop that times out leaves the VM in
 * `stopping` and is retried by running `vm stop` again. `stopped -> stopping` is not allowed.
 * `starting -> stopping` lets an operator stop a VM whose launcher is alive but not yet QMP-ready.
 */
const ALLOWED: Record<VmState, readonly VmState[]> = {
  stopped: ["starting", "destroying"],
  starting: ["running", "stopped", "stopping"],
  running: ["stopping", "stopped"],
  stopping: ["stopped"],
  destroying: ["deleted"],
  deleted: [],
}

export const canTransition = (from: VmState, to: VmState): boolean => ALLOWED[from].includes(to)

export interface VmFields {
  readonly process: ProcessRef | null
  readonly lastError: string | null
}

export const transitionVm = (vm: VmRecord, to: VmState, fields: VmFields, now: string): VmRecord => {
  if (!canTransition(vm.state, to)) {
    throw new HostError(`illegal VM state transition for ${vm.vmId}: ${vm.state} -> ${to}`)
  }
  return { ...vm, ...fields, state: to, sequence: vm.sequence + 1, updatedAt: now }
}

export const updateVm = (vm: VmRecord, fields: Partial<VmFields>, now: string): VmRecord => ({
  ...vm,
  ...fields,
  updatedAt: now,
})

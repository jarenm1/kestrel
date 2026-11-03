import { acquireVmLock, LockBusyError, type VmLock } from "./lock"
import { probeQmp } from "./qmp"
import { isProcessAlive, processBelongsToVm } from "./proc"
import { listVmIds, readVm, vmPaths } from "./state-store"
import type { VmRecord, VmState } from "./schema"
import { finishDestroy, GONE_AT_RECONCILE } from "./vm"
import { closingEvent, commitState, vmProcessName, type HostContext } from "./vm-state"

const QMP_PROBE_TIMEOUT_MS = 500

export interface ReconcileChange {
  readonly vmId: string
  readonly from: VmState
  readonly to: VmState
  readonly reason: string
}

const change = (vm: VmRecord, to: VmState, reason: string): ReconcileChange => ({
  vmId: vm.vmId,
  from: vm.state,
  to,
  reason,
})

/**
 * Brings one VM's recorded state in line with the processes on the host. Caller must hold the VM lock.
 *  - starting: process alive and QMP answers -> running (emits running); process gone -> stopped (no event:
 *    the VM never reported running). A live but not-yet-answering launcher stays starting.
 *  - running/stopping: process not owned by this VM -> stopped with lastError (emits parked if running was reported).
 *  - destroying: process gone -> finish removal (emits deleted).
 */
export const reconcileLocked = async (ctx: HostContext, vmId: string): Promise<ReconcileChange | null> => {
  const vm = readVm(ctx.stateDir, vmId)
  if (vm === null) return null
  const name = vmProcessName(vmId)
  switch (vm.state) {
    case "starting": {
      if (isProcessAlive(vm.process)) {
        const paths = vmPaths(ctx.stateDir, vmId)
        if (!processBelongsToVm(vm.process, name) || !(await probeQmp(paths.qmpSock, QMP_PROBE_TIMEOUT_MS))) {
          return null
        }
        commitState(ctx, vm, "running", { process: vm.process, lastError: null }, "running")
        return change(vm, "running", "QMP answered at reconcile")
      }
      commitState(ctx, vm, "stopped", { process: null, lastError: GONE_AT_RECONCILE }, null)
      return change(vm, "stopped", GONE_AT_RECONCILE)
    }
    case "running":
    case "stopping": {
      if (processBelongsToVm(vm.process, name)) return null
      commitState(ctx, vm, "stopped", { process: null, lastError: GONE_AT_RECONCILE }, closingEvent(vm))
      return change(vm, "stopped", GONE_AT_RECONCILE)
    }
    case "destroying": {
      if (isProcessAlive(vm.process)) return null
      finishDestroy(ctx, vm)
      return change(vm, "deleted", "resumed interrupted destroy")
    }
    case "stopped":
    case "deleted":
      return null
  }
}

/**
 * Reconciles every VM. Takes each VM's lock without waiting: busy VMs are skipped (another CLI owns them)
 * and stale locks left by dead owners are cleared by acquireVmLock.
 */
export const reconcileAll = async (ctx: HostContext): Promise<ReconcileChange[]> => {
  const changes: ReconcileChange[] = []
  for (const vmId of listVmIds(ctx.stateDir)) {
    let lock: VmLock
    try {
      lock = acquireVmLock(vmPaths(ctx.stateDir, vmId).dir)
    } catch (error) {
      if (error instanceof LockBusyError) {
        ctx.warn(`reconcile: skipping VM ${vmId}: ${error.message}`)
        continue
      }
      throw error
    }
    try {
      const result = await reconcileLocked(ctx, vmId)
      if (result !== null) changes.push(result)
    } finally {
      lock.release()
    }
  }
  return changes
}

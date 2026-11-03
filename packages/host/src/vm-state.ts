import { appendLifecycleEvent, buildLifecycleRecord, type HostLifecycleState } from "./lifecycle"
import { writeVm } from "./state-store"
import { transitionVm, updateVm, type VmFields } from "./transitions"
import type { VmRecord, VmState } from "./schema"

export interface HostContext {
  /** Absolute state directory. */
  readonly stateDir: string
  /** Launcher script spawned for `start`. */
  readonly launcher: string
  /** Raw KESTREL_VM_ACCEL value; validated when a VM starts. */
  readonly accel: string
  /** How long `start` waits for the launcher to answer on QMP. */
  readonly readyTimeoutMs: number
  /** Environment for the launcher (inherits the caller's env). */
  readonly env: NodeJS.ProcessEnv
  /** Operator-facing warnings (stderr). */
  readonly warn: (message: string) => void
}

/** QEMU process name (`-name`); the identity check in /proc/<pid>/cmdline matches on it. */
export const vmProcessName = (vmId: string): string => `kestrel-${vmId}`

/**
 * Applies a state transition and persists it. The lifecycle event (if any) is appended and fsynced first:
 * a crash between the two can duplicate an event on retry but never drops one.
 */
export const commitState = (
  ctx: HostContext,
  vm: VmRecord,
  to: VmState,
  fields: VmFields,
  event: HostLifecycleState | null,
): VmRecord => {
  const runningReported = event === "running" || (event === null && vm.runningReported)
  const next = { ...transitionVm(vm, to, fields, new Date().toISOString()), runningReported }
  if (event !== null) {
    appendLifecycleEvent(
      ctx.stateDir,
      buildLifecycleRecord({ hostId: vm.hostId, vmId: vm.vmId, userId: vm.userId, state: event }),
    )
  }
  writeVm(ctx.stateDir, next)
  return next
}

/** Event that closes the VM's lifecycle record: `parked` only when a `running` record was written. */
export const closingEvent = (vm: VmRecord): "parked" | null => (vm.runningReported ? "parked" : null)

/** Persists a field-only update (no state change). */
export const commitFields = (ctx: HostContext, vm: VmRecord, fields: Partial<VmFields>): VmRecord => {
  const next = updateVm(vm, fields, new Date().toISOString())
  writeVm(ctx.stateDir, next)
  return next
}

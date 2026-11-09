import type { NestVmState } from "@cloudagents/protocol"
import type { VmRecord } from "./schema"

/**
 * What survives a restart, decided from the record and the live processes. Pure: the caller observes the facts and
 * carries out the plan. Every interrupted operation rolls back to the state it can be resumed from, so the record
 * never claims a process or a memory image that is gone.
 */

export interface RecoveryFacts {
  /** The VMM process recorded in `vm.json` is alive (pid and start time match). */
  readonly vmmAlive: boolean
  /** The volume process recorded in `vm.json` is alive. */
  readonly volumeAlive: boolean
  /** The memory image of the recorded `snapshotGen` exists on disk. */
  readonly snapshotExists: boolean
}

export interface RecoveryPlan {
  readonly state: NestVmState
  /** Keep the running VMM and continue as if nothing happened. */
  readonly adoptVmm: boolean
  readonly killVmm: boolean
  readonly killVolume: boolean
  readonly clearNetwork: boolean
  readonly dropMemoryImages: boolean
  /** A create or destroy is finished or rolled back: the VM's files are removed. */
  readonly deleteArtifacts: boolean
}

export const recoverPlan = (record: VmRecord, facts: RecoveryFacts): RecoveryPlan => {
  const volumeGone = record.volumeProcess !== null && !facts.volumeAlive
  const stopAll = (state: NestVmState, extra: Partial<RecoveryPlan> = {}): RecoveryPlan => ({
    state,
    adoptVmm: false,
    killVmm: facts.vmmAlive,
    killVolume: facts.volumeAlive,
    clearNetwork: true,
    dropMemoryImages: true,
    deleteArtifacts: false,
    ...extra,
  })
  // A freeze ends only with thawVolume or a stop. A running VM found frozen is not trusted, so it is stopped.
  if (record.frozen && record.state === "running") return stopAll("parked")
  const kind = record.operation?.kind ?? null
  if (kind === null) {
    switch (record.state) {
      case "running":
        if (facts.vmmAlive && !volumeGone) {
          // An adopted VMM keeps its recorded memory image: the image is not stale just because the process survived.
          return {
            ...stopAll("running"),
            adoptVmm: true,
            killVmm: false,
            killVolume: false,
            clearNetwork: false,
            dropMemoryImages: false,
          }
        }
        return stopAll("parked")
      case "suspended":
        if (facts.snapshotExists && !volumeGone) {
          return { ...stopAll("suspended"), killVolume: false, clearNetwork: false, dropMemoryImages: false }
        }
        return stopAll("parked")
      case "parked":
        return stopAll("parked")
      case "provisioning":
        return stopAll("deleted", { deleteArtifacts: true })
      case "deleted":
        return stopAll("deleted")
    }
  }
  switch (kind) {
    case "create":
      return stopAll("deleted", { deleteArtifacts: true })
    case "destroy":
      return stopAll("deleted", { deleteArtifacts: true })
    case "resume":
      if (record.operation?.from === "suspended" && facts.snapshotExists && !volumeGone) {
        return { ...stopAll("suspended"), killVolume: false, clearNetwork: false, dropMemoryImages: false }
      }
      return stopAll("parked")
    // The disk moves on while a suspend quiesces, so the previous generation's memory image no longer matches it.
    case "suspend":
    case "park":
    case "gpuAttach":
    case "gpuDetach":
      return stopAll("parked")
  }
}

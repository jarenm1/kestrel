import type { ServerEvent } from "@cloudagents/protocol"

/**
 * Which runs want the box's GPU. The box wants it while any run does: one run's release or timeout withdraws only that
 * run's request, so a run that finishes does not take the GPU from another run that is still using it.
 */
export class GpuWishes {
  private readonly runs = new Set<string>()

  /** Records the run's wish; returns whether the box wants the GPU. */
  add(runId: string): boolean {
    this.runs.add(runId)
    return this.wanted()
  }

  /** Withdraws the run's wish; returns whether the box still wants the GPU. */
  remove(runId: string): boolean {
    this.runs.delete(runId)
    return this.wanted()
  }

  /** Whether the run has a wish standing. */
  has(runId: string): boolean {
    return this.runs.has(runId)
  }

  wanted(): boolean {
    return this.runs.size > 0
  }
}

/**
 * Withdraws a run's wish when the run ends, whatever the outcome (succeeded, failed or cancelled; a shutdown cancels
 * every run). `subscribeAll` is the event hub's; `setWanted` receives the box's state after a wish is withdrawn. A run
 * that never asked for the GPU changes nothing. Returns the unsubscribe.
 */
export const withdrawWishesOnRunEnd = (
  subscribeAll: (listener: (event: ServerEvent) => void) => () => void,
  wishes: GpuWishes,
  setWanted: (wanted: boolean) => void,
): (() => void) =>
  subscribeAll((event) => {
    if (event._tag !== "run.updated" || event.run.status === "running") return
    if (wishes.has(event.run.id)) setWanted(wishes.remove(event.run.id))
  })

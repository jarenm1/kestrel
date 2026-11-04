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

  wanted(): boolean {
    return this.runs.size > 0
  }
}

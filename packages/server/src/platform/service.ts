import { Context, Data, Effect } from "effect"
import type { GpuSnapshot } from "./gpu-state"

export class PlatformError extends Data.TaggedError("PlatformError")<{ readonly message: string }> {}

/** What the machine the box runs on adds to the capabilities it reports. */
export interface PlatformHardware {
  readonly gpu: "none" | "static" | "on-demand"
  readonly suspend: boolean
}

/** A GPU the host lends the box while it is needed. */
export interface GpuOnDemand {
  /** Asks the host for the GPU on behalf of a run and waits until it is attached; fails when it does not attach in time. */
  readonly request: (runId: string) => Effect.Effect<void, PlatformError>
  /** Withdraws the run's request. The host detaches the GPU once no run wants it. */
  readonly release: (runId: string) => Effect.Effect<void, PlatformError>
  /** The host's last `GpuState` and what the box reconciled it to; for diagnostics and status. */
  readonly state: Effect.Effect<GpuSnapshot>
}

export interface PlatformHooks {
  /** Runs after the host reports the VM was restored from a snapshot: reconnects outbound sockets. */
  readonly resumed: Effect.Effect<void>
}

export interface BoxPlatformShape {
  /** Null where the machine adds nothing to the capabilities (a plain host). */
  readonly hardware: PlatformHardware | null
  /** Null where no GPU can be lent to the box. */
  readonly gpuOnDemand: GpuOnDemand | null
  /** Serves the platform's side of the box (the guest link) until interrupted. */
  readonly run: (hooks: PlatformHooks) => Effect.Effect<void>
}

export class BoxPlatform extends Context.Tag("cloudagents/BoxPlatform")<BoxPlatform, BoxPlatformShape>() {}

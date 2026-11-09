import type { DesktopState } from "@cloudagents/protocol"

/** The lifecycle fields of a desktop session. Encoder presence is a separate fact, not part of this phase. */
export interface DesktopPhase {
  readonly state: DesktopState
  readonly error: string | null
}

export type DesktopEvent =
  /** A new boot is beginning. */
  | { readonly _tag: "started" }
  /** The first H.264 config arrived: the desktop is running and attachable. */
  | { readonly _tag: "configured" }
  /** A boot, encoder or input failure terminated the processes. */
  | { readonly _tag: "failed"; readonly message: string }
  /** The session was stopped, explicitly or after its last viewer left. */
  | { readonly _tag: "stopped" }

export type DesktopIllegalReason = "already-active" | "not-active"

export type DesktopTransition =
  | { readonly _tag: "transitioned"; readonly phase: DesktopPhase; readonly changed: boolean }
  | { readonly _tag: "illegal"; readonly reason: DesktopIllegalReason }

/**
 * Writes the transition to a session-like record. It touches only the lifecycle fields; the caller still owns the
 * processes, encoder, watchers and the `ready` deferred.
 */
export const applyDesktopEvent = (
  target: { state: DesktopState; error: string | null },
  event: DesktopEvent,
): DesktopTransition => {
  const transition = transitionDesktop({ state: target.state, error: target.error }, event)
  if (transition._tag === "transitioned") {
    target.state = transition.phase.state
    target.error = transition.phase.error
  }
  return transition
}

/**
 * The one writer of a desktop's lifecycle state. `running` means the processes are alive; it does not mean an encoder
 * is present or a viewer is attached. A failed session can start again only through `started`, like a stopped one.
 */
export const transitionDesktop = (phase: DesktopPhase, event: DesktopEvent): DesktopTransition => {
  switch (event._tag) {
    case "started":
      if (phase.state === "starting" || phase.state === "running") {
        return { _tag: "illegal", reason: "already-active" }
      }
      return { _tag: "transitioned", phase: { state: "starting", error: null }, changed: true }
    case "configured":
      // A config after an encoder restart is expected while the session is already running; it is the same phase.
      if (phase.state === "running") {
        return { _tag: "transitioned", phase: { state: "running", error: null }, changed: phase.error !== null }
      }
      if (phase.state !== "starting") return { _tag: "illegal", reason: "not-active" }
      return { _tag: "transitioned", phase: { state: "running", error: null }, changed: true }
    case "failed":
      if (phase.state !== "starting" && phase.state !== "running") {
        return { _tag: "illegal", reason: "not-active" }
      }
      return { _tag: "transitioned", phase: { state: "failed", error: event.message }, changed: true }
    case "stopped":
      if (phase.state === "stopped") {
        return { _tag: "transitioned", phase: { state: "stopped", error: null }, changed: false }
      }
      return { _tag: "transitioned", phase: { state: "stopped", error: null }, changed: true }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

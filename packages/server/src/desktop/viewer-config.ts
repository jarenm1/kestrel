import type { DesktopState } from "@cloudagents/protocol"

/** Per-socket state of the desktop ICE config. The one writer for status and `rtc.config.request` events. */
export interface ViewerConfig {
  /** An `rtc.config` went out for the current desktop session. */
  readonly sent: boolean
  /** A `rtc.config.request` arrived before the current session's first config. */
  readonly requested: boolean
  /** The last lifecycle state this viewer saw; null before the first status. */
  readonly state: DesktopState | null
}

export const viewerConfig = (): ViewerConfig => ({ sent: false, requested: false, state: null })

export type ViewerConfigEvent =
  | { readonly _tag: "status"; readonly state: DesktopState }
  | { readonly _tag: "config-request" }

export interface ViewerConfigStep {
  readonly config: ViewerConfig
  /** Send the ICE config now. */
  readonly sendConfig: boolean
  /** Send the status; after the config when both are set. */
  readonly sendStatus: boolean
}

/**
 * A stop, a failure or a restart (any non-running state, or running after one) starts a new desktop session whose ICE
 * config must be fetched again. A request before that first config is remembered and answered by it; a request while a
 * config is current is answered with a fresh one. A repeated running status sends no config.
 */
export const viewerConfigStep = (config: ViewerConfig, event: ViewerConfigEvent): ViewerConfigStep => {
  if (event._tag === "config-request") {
    return config.sent
      ? { config, sendConfig: true, sendStatus: false }
      : { config: { ...config, requested: true }, sendConfig: false, sendStatus: false }
  }
  if (event.state !== "running") {
    return { config: { sent: false, requested: config.requested, state: event.state }, sendConfig: false, sendStatus: true }
  }
  const sent = config.state === "running" && config.sent
  if (!sent) {
    return {
      config: { sent: true, requested: false, state: event.state },
      sendConfig: true,
      sendStatus: true,
    }
  }
  return {
    config: { sent: true, requested: false, state: event.state },
    sendConfig: config.requested,
    sendStatus: true,
  }
}

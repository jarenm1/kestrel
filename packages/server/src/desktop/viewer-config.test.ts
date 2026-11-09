import { describe, expect, test } from "bun:test"
import { viewerConfig, viewerConfigStep, type ViewerConfig } from "./viewer-config"

const status = (config: ViewerConfig, state: "stopped" | "starting" | "running" | "failed") =>
  viewerConfigStep(config, { _tag: "status", state })
const request = (config: ViewerConfig) => viewerConfigStep(config, { _tag: "config-request" })

describe("viewer ICE config state", () => {
  test("a request before the first config is remembered and answered by it", () => {
    const queued = request(viewerConfig())
    expect(queued.config.requested).toBe(true)
    expect(queued.sendConfig).toBe(false)

    const running = status(queued.config, "running")
    expect(running.sendConfig).toBe(true)
    expect(running.sendStatus).toBe(true)
    expect(running.config.requested).toBe(false)
    expect(running.config.sent).toBe(true)
  })

  test("a request while the current config is sent gets a fresh config", () => {
    const running = status(viewerConfig(), "running")
    const refreshed = request(running.config)
    expect(refreshed.sendConfig).toBe(true)
    expect(refreshed.sendStatus).toBe(false)
    expect(refreshed.config.sent).toBe(true)
  })

  test("a stop, a failure or a restart invalidates the session's config", () => {
    let config = status(viewerConfig(), "running").config
    for (const state of ["stopped", "failed", "starting"] as const) {
      const step = status(config, state)
      expect(step.sendConfig).toBe(false)
      expect(step.sendStatus).toBe(true)
      expect(step.config.sent).toBe(false)
      // The next running status fetches a config for the new session.
      const restarted = status(step.config, "running")
      expect(restarted.sendConfig).toBe(true)
      config = restarted.config
    }
  })

  test("a repeated running status does not resend the config", () => {
    const first = status(viewerConfig(), "running")
    const repeated = status(first.config, "running")
    expect(repeated.sendConfig).toBe(false)
    expect(repeated.sendStatus).toBe(true)
  })

  test("a request made while stopped is answered by the next session's config", () => {
    const stopped = status(viewerConfig(), "stopped")
    const queued = request(stopped.config)
    expect(queued.config.requested).toBe(true)
    const running = status(queued.config, "running")
    expect(running.sendConfig).toBe(true)
    expect(running.config.requested).toBe(false)
  })
})

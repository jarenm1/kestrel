import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { release } from "node:os"
import type { BoxCapabilities } from "@cloudagents/protocol"
import { DESKTOP_HELPER, DESKTOP_REQUIRED_TOOLS, MIN_WESTON_MAJOR, parseWestonVersion } from "./desktop/requirements"

interface CapabilityProbe {
  readonly platform: NodeJS.Platform
  readonly release: string
  readonly exists: (path: string) => boolean
  readonly executable: (name: string) => boolean
  readonly westonVersion: () => string
}

const hostProbe = (): CapabilityProbe => ({
  platform: process.platform,
  release: release(),
  exists: (path) => existsSync(path),
  executable: (name) => Bun.which(name) !== null,
  // weston prints its version on stdout or stderr depending on build; an empty result means it did not answer.
  westonVersion: () => {
    const run = spawnSync("weston", ["--version"], { encoding: "utf8", timeout: 2000 })
    return run.error ? "" : run.stdout + run.stderr
  },
})

// Lima mounts its cloud-init seed ISO here on every guest it boots (checked on Lima 2.x, Ubuntu 24.04, qemu).
const LIMA_SEED = "/mnt/lima-cidata"

const platformOf = (probe: CapabilityProbe): BoxCapabilities["platform"] => {
  if (probe.platform !== "linux") return "other"
  if (probe.exists(LIMA_SEED)) return "lima"
  return /microsoft/i.test(probe.release) ? "wsl" : "linux"
}

/** Startup snapshot only: runtime resources, drivers and permissions can still prevent a desktop from starting. */
export const boxCapabilities = (
  sandbox: BoxCapabilities["sandbox"],
  probe: CapabilityProbe = hostProbe(),
): BoxCapabilities => {
  const platform = platformOf(probe)
  // Only what a desktop start needs; optional tools (see requirements.ts) do not change the answer.
  let desktop = false
  if (platform !== "other" && [...DESKTOP_REQUIRED_TOOLS, DESKTOP_HELPER].every(probe.executable)) {
    const version = parseWestonVersion(probe.westonVersion())
    desktop = version !== null && version.major >= MIN_WESTON_MAJOR
  }
  return { version: 1, platform, sandbox, desktop: desktop ? "prerequisites-present" : "unavailable" }
}

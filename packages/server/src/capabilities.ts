import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { release } from "node:os"
import type { BoxCapabilities } from "@cloudagents/protocol"

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
  westonVersion: () => execFileSync("weston", ["--version"], { encoding: "utf8", timeout: 2000 }),
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
  // These run on the box. The terminal and wallpaper are optional conveniences, not desktop prerequisites.
  const tools = ["weston", "Xwayland", "openbox", "xdotool", "ffmpeg", "xdamage-capture"]
  let desktop = false
  if (platform !== "other" && tools.every(probe.executable)) {
    try {
      const major = /weston (\d+)\./i.exec(probe.westonVersion())?.[1]
      desktop = major !== undefined && Number(major) >= 14
    } catch {
      // A version probe that fails or times out has not confirmed the prerequisites.
    }
  }
  return { version: 1, platform, sandbox, desktop: desktop ? "prerequisites-present" : "unavailable" }
}

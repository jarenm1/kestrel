import { execFileSync } from "node:child_process"
import { release } from "node:os"
import type { BoxCapabilities } from "@cloudagents/protocol"

interface CapabilityProbe {
  readonly platform: NodeJS.Platform
  readonly release: string
  readonly executable: (name: string) => boolean
  readonly westonVersion: () => string
}

const hostProbe = (): CapabilityProbe => ({
  platform: process.platform,
  release: release(),
  executable: (name) => Bun.which(name) !== null,
  westonVersion: () => execFileSync("weston", ["--version"], { encoding: "utf8", timeout: 2000 }),
})

/** Startup snapshot only: runtime resources, drivers and permissions can still prevent a desktop from starting. */
export const boxCapabilities = (
  sandbox: BoxCapabilities["sandbox"],
  probe: CapabilityProbe = hostProbe(),
): BoxCapabilities => {
  const platform = probe.platform !== "linux" ? "other" : /microsoft/i.test(probe.release) ? "wsl" : "linux"
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

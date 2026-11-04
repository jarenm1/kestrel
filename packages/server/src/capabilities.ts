import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { ModelProvider, type BoxCapabilities } from "@cloudagents/protocol"
import { MODEL_HARNESS } from "./agent-clis"
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

/** Finds a harness CLI where agent runs look for it, and asks it its version. */
export interface HarnessProbe {
  /** The executable's path on the PATH agent runs get, or null. */
  readonly which: (name: string) => string | null
  /** What `<path> --version` printed; empty when it did not answer. */
  readonly version: (path: string) => string
}

/** Agent runs get the toolchain's PATH under `strict` (`CLOUDAGENTS_SANDBOX_PATH`), the box's own otherwise. */
export const harnessProbe = (sandboxPath: string | null): HarnessProbe => {
  const PATH = sandboxPath ?? process.env.PATH ?? ""
  return {
    which: (name) => Bun.which(name, { PATH }),
    version: (path) => {
      const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 })
      return run.error ? "" : run.stdout + run.stderr
    },
  }
}

/** Providers the scripted agent (`scripts/fake-agent.ts`) plays: Claude stream-json, Codex app-server and ACP. */
const FAKE_AGENT_PROVIDERS: ReadonlyArray<ModelProvider> = ["anthropic", "openai", "opencode", "google"]

/**
 * The model providers whose harness CLI the box can run, at startup: found where agent runs look, and at least the
 * version the harness needs. A fake-agent box plays the providers its script speaks for itself.
 */
export const availableHarnesses = (
  config: { readonly fakeAgent: boolean; readonly sandboxPath: string | null },
  probe: HarnessProbe = harnessProbe(config.sandboxPath),
): ReadonlyArray<ModelProvider> =>
  ModelProvider.literals.filter((provider) => {
    if (config.fakeAgent) return FAKE_AGENT_PROVIDERS.includes(provider)
    const harness = MODEL_HARNESS[provider]
    const path = probe.which(harness.bin)
    if (path === null) return false
    if (harness.minVersion === null) return true
    const found = /(\d+)\.(\d+)/.exec(probe.version(path))
    if (found === null) return false
    const [major, minor] = [Number(found[1]), Number(found[2])]
    const [needMajor, needMinor] = harness.minVersion
    return major > needMajor || (major === needMajor && minor >= needMinor)
  })

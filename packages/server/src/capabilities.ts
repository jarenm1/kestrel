import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { MODEL_PROVIDERS, ModelHarness, ModelProvider, type BoxCapabilities } from "@cloudagents/protocol"
import { MODEL_HARNESS, harnessForRoute, type Harness, type HarnessMinimum } from "./agent-clis"
import { DESKTOP_HELPER, DESKTOP_REQUIRED_TOOLS, MIN_WESTON_MAJOR, hasRenderNode, parseWestonVersion } from "./desktop/requirements"
import type { PlatformHardware } from "./platform/service"

interface CapabilityProbe {
  readonly platform: NodeJS.Platform
  readonly release: string
  readonly exists: (path: string) => boolean
  readonly executable: (name: string) => boolean
  readonly westonVersion: () => string
  readonly renderNode: () => boolean
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
  renderNode: hasRenderNode,
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
  hardware: PlatformHardware | null = null,
): BoxCapabilities => {
  const platform = platformOf(probe)
  // Only what a desktop start needs; optional tools (see requirements.ts) do not change the answer.
  let desktop = false
  if (platform !== "other" && [...DESKTOP_REQUIRED_TOOLS, DESKTOP_HELPER].every(probe.executable)) {
    const version = parseWestonVersion(probe.westonVersion())
    desktop = version !== null && version.major >= MIN_WESTON_MAJOR
  }
  const gpu = hardware?.gpu ?? (probe.renderNode() ? "static" : "none")
  const suspend = hardware?.suspend ?? false
  return {
    version: 1,
    platform,
    sandbox,
    desktop: desktop ? "prerequisites-present" : "unavailable",
    gpu,
    suspend,
    // Explicit recording needs only the desktop's encoder and ffmpeg (both required desktop tools); the rolling
    // buffer is not built. The desktop itself may still be unavailable at runtime.
    evidence: { recording: true, rollingBuffer: false },
  }
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
    // A configured command may name a binary by path (`/opt/opencode/bin/opencode`); PATH lookup would miss it.
    which: (name) =>
      name.includes("/") || name.includes("\\")
        ? existsSync(name)
          ? name
          : null
        : Bun.which(name, { PATH }),
    version: (path) => {
      const run = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 })
      return run.error ? "" : run.stdout + run.stderr
    },
  }
}

/**
 * Providers the scripted agent (`scripts/fake-agent.ts`) plays. It speaks Claude stream-json, Codex app-server and ACP,
 * and `CLOUDAGENTS_HARNESS` tells it which one a routed model needs, so every provider is playable in fake mode.
 */
const FAKE_AGENT_PROVIDERS: ReadonlyArray<ModelProvider> = ModelProvider.literals

/**
 * The binary a configured harness command starts: its first shell word, with any leading `VAR=value` assignments
 * skipped. A quoted value is taken whole, so OpenCode's JSON config (which has spaces) does not confuse the scan, and
 * a quoted word is taken whole so a quoted absolute path (as `config.ts` writes commands) probes intact.
 */
export const harnessBinary = (command: string): string | null => {
  let rest = command.trimStart()
  for (;;) {
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(rest)
    if (assignment === null) break
    let at = assignment[0].length
    const quote = rest[at]
    if (quote === "'" || quote === '"') {
      const close = rest.indexOf(quote, at + 1)
      at = close === -1 ? rest.length : close + 1
    } else {
      while (at < rest.length && !/\s/.test(rest[at]!)) at++
    }
    rest = rest.slice(at).trimStart()
  }
  const word = /^(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(rest)
  return word?.[1] ?? word?.[2] ?? word?.[3] ?? null
}

/** What the box knows about one provider's harness CLI: whether a run can start it, and why not. */
export interface HarnessAvailability {
  readonly available: boolean
  /** Why a run cannot start the CLI; absent when it can. */
  readonly error?: string
}

/** The selected box's view of its harness commands; `agentCommands` is absent only in probes and unit fixtures. */
export interface HarnessConfig {
  readonly fakeAgent: boolean
  readonly agentCommands?: Readonly<Partial<Record<ModelProvider, string>>>
  /** Canonical command per harness kind for models whose route names another harness. */
  readonly agentRouteCommands?: Readonly<Partial<Record<ModelHarness, string>>>
}

export const meetsMinimum = (printed: string, minimum: HarnessMinimum | null): boolean => {
  if (minimum === null) return true
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(printed)
  if (found === null) return false
  const [major, minor, patch] = [Number(found[1]), Number(found[2]), Number(found[3] ?? 0)]
  const [needMajor, needMinor] = minimum
  const needPatch = minimum.length === 3 ? minimum[2] : 0
  return (
    major > needMajor ||
    (major === needMajor && (minor > needMinor || (minor === needMinor && patch >= needPatch)))
  )
}

/**
 * Whether a provider's harness, or a route's alternative harness, can start a run on this box: configured where agent
 * runs look, and at least the version it needs. A fake-agent box plays every harness itself, without probing a binary.
 * Only the selected harness's command is probed, so a launch never runs every harness's `--version`.
 */
export const harnessAvailability = (
  provider: ModelProvider,
  config: HarnessConfig,
  probe: HarnessProbe,
  harness?: Harness,
  commandOverride?: string,
): HarnessAvailability => {
  const name = MODEL_PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? provider
  if (config.fakeAgent) {
    return FAKE_AGENT_PROVIDERS.includes(provider)
      ? { available: true }
      : { available: false, error: `the fake agent does not play ${name}; start the box without CLOUDAGENTS_FAKE_AGENT` }
  }
  const selected = harness ?? MODEL_HARNESS[provider]
  const command = commandOverride ?? (harness === undefined ? config.agentCommands?.[provider] : undefined)
  const binary = command === undefined ? selected.bin : harnessBinary(command)
  if (binary === null) {
    return { available: false, error: `${name} has no command configured on this box` }
  }
  const path = probe.which(binary)
  if (path === null) {
    return { available: false, error: `its CLI (${binary}) is not installed on this box` }
  }
  const minimum = selected.minVersion
  if (minimum !== null && !meetsMinimum(probe.version(path), minimum)) {
    return { available: false, error: `its CLI (${binary}) must be version ${minimum.join(".")} or newer` }
  }
  return { available: true }
}

/**
 * The model providers whose harness CLI the box can run, at startup: found where agent runs look, and at least the
 * version the harness needs. A fake-agent box plays every harness itself.
 */
export const availableHarnesses = (
  config: HarnessConfig & { readonly sandboxPath: string | null },
  probe: HarnessProbe = harnessProbe(config.sandboxPath),
): ReadonlyArray<ModelProvider> =>
  ModelProvider.literals.filter((provider) => harnessAvailability(provider, config, probe).available)

/**
 * Harness kinds the box can launch for routed models. Unlike `availableHarnesses`, OpenCode here means the route
 * minimum (2.1), not the older native-free minimum; clients use it to offer only routes whose CLI is installed.
 */
export const availableModelHarnesses = (
  config: HarnessConfig & { readonly sandboxPath: string | null },
  probe: HarnessProbe = harnessProbe(config.sandboxPath),
): ReadonlyArray<ModelHarness> => {
  if (config.fakeAgent) return ModelHarness.literals
  return ModelHarness.literals.filter((actual) => {
    const definition = harnessForRoute(actual)
    const command =
      actual === "antigravity"
        ? config.agentCommands?.google
        : actual === "devin"
          ? config.agentCommands?.devin
          : config.agentRouteCommands?.[actual]
    const binary = command === undefined ? definition.bin : harnessBinary(command)
    if (binary === null) return false
    const path = probe.which(binary)
    if (path === null) return false
    return definition.minVersion === null || meetsMinimum(probe.version(path), definition.minVersion)
  })
}

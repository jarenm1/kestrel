import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { providerInfo, ModelProvider, type BoxCapabilities } from "@cloudagents/protocol"
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

/** Providers the scripted agent (`scripts/fake-agent.ts`) plays: Claude stream-json, Codex app-server and ACP. */
const FAKE_AGENT_PROVIDERS: ReadonlyArray<ModelProvider> = ["anthropic", "openai", "opencode", "opencode-go", "google"]

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
}

export const meetsMinimum = (printed: string, minimum: readonly [number, number] | null): boolean => {
  if (minimum === null) return true
  const found = /(\d+)\.(\d+)/.exec(printed)
  if (found === null) return false
  const [major, minor] = [Number(found[1]), Number(found[2])]
  const [needMajor, needMinor] = minimum
  return major > needMajor || (major === needMajor && minor >= needMinor)
}

/**
 * Whether one provider's harness CLI can start a run on this box: configured where agent runs look, and at least the
 * version its harness needs. A fake-agent box plays the providers its script speaks for itself, without probing a
 * binary. Only this provider's command is probed, so a launch never runs every harness's `--version`.
 */
export const harnessAvailability = (
  provider: ModelProvider,
  config: HarnessConfig,
  probe: HarnessProbe,
): HarnessAvailability => {
  const info = providerInfo(provider)
  if (config.fakeAgent) {
    return FAKE_AGENT_PROVIDERS.includes(provider)
      ? { available: true }
      : { available: false, error: `the fake agent does not play ${info.name}; start the box without CLOUDAGENTS_FAKE_AGENT` }
  }
  const command = config.agentCommands?.[provider]
  const binary = command === undefined ? MODEL_HARNESS[provider].bin : harnessBinary(command)
  if (binary === null) {
    return { available: false, error: `${info.name} has no command configured on this box` }
  }
  const path = probe.which(binary)
  if (path === null) {
    const install = info.setup === undefined ? "" : `; install it with: ${info.setup}`
    return { available: false, error: `its CLI (${binary}) is not installed on this box${install}` }
  }
  // An adapter that starts the agent itself (Pi's `pi-acp` runs `pi`) needs both binaries in a run.
  for (const required of MODEL_HARNESS[provider].requires ?? []) {
    if (probe.which(required) === null) {
      const install = info.setup === undefined ? "" : `; install it with: ${info.setup}`
      return { available: false, error: `its CLI (${binary}) needs ${required}, which is not installed on this box${install}` }
    }
  }
  const minimum = MODEL_HARNESS[provider].minVersion
  if (minimum !== null && !meetsMinimum(probe.version(path), minimum)) {
    return { available: false, error: `its CLI (${binary}) must be version ${minimum[0]}.${minimum[1]} or newer` }
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

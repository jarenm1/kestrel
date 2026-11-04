import { MODEL_PROVIDERS, type AcpHarnessId, type HarnessStatus } from "@cloudagents/protocol"
import type { ServerConfig } from "./config"

/**
 * Which standalone ACP harnesses this box can launch (OMP, Pi, Hermes). Their CLIs are host binaries a run starts
 * from PATH, so a harness whose CLI is not installed can never run: the box says so instead of offering it.
 */
export interface HarnessProbe {
  /** True when `name` resolves to an executable on this box's PATH. */
  readonly executable: (name: string) => boolean
}

const hostProbe: HarnessProbe = { executable: (name) => Bun.which(name) !== null }

/**
 * The binary a configured harness command starts: its first shell word, with any leading `VAR=value` assignments
 * skipped. A quoted word is taken whole, so a quoted absolute path (as `config.ts` writes commands) probes intact.
 */
const FIRST_WORD = /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(?:'([^']*)'|"([^"]*)"|(\S+))/

export const harnessBinary = (command: string): string | null => {
  const match = FIRST_WORD.exec(command)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

/**
 * One entry per standalone harness. This is the box's answer to "can a run here use this harness", which Connections
 * shows and the model picker gates on; it carries no login state, because a harness reaches models through the
 * broker (see `docs/harnesses.md`).
 */
export const harnessStatuses = (
  config: Pick<ServerConfig, "agentCommands" | "fakeAgent">,
  probe: HarnessProbe = hostProbe,
): ReadonlyArray<HarnessStatus> =>
  MODEL_PROVIDERS.filter((provider) => provider.standalone === true).map((provider) => {
    const harness = provider.id as AcpHarnessId
    if (config.fakeAgent) {
      return { harness, available: false, error: "the fake agent cannot run an ACP harness; start the box without CLOUDAGENTS_FAKE_AGENT" }
    }
    const binary = harnessBinary(config.agentCommands[provider.id])
    if (binary === null || !probe.executable(binary)) {
      return { harness, available: false, error: `its CLI (${binary ?? provider.name}) is not installed on this box` }
    }
    return { harness, available: true }
  })

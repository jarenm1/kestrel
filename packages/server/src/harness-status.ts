import { MODEL_PROVIDERS, type AcpHarnessId, type HarnessStatus } from "@cloudagents/protocol"
import { MODEL_HARNESS } from "./agent-clis"
import { harnessProbe, type HarnessProbe } from "./capabilities"
import type { ServerConfig } from "./config"

/**
 * Which standalone ACP harnesses this box can launch (OpenCode, OMP, Pi, Hermes). Their CLIs are host binaries a run
 * starts from PATH, so a harness whose CLI is not installed, or is older than the version its harness needs, can never
 * run: the box says so instead of offering it.
 */

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

/**
 * One entry per standalone harness. This is the box's answer to "can a run here use this harness", which Connections
 * shows and the model picker gates on; it carries no login state, because a harness reaches models through the
 * broker (see `docs/harnesses.md`). OpenCode runs its own free models and needs no broker.
 */
export const harnessStatuses = (
  config: Pick<ServerConfig, "agentCommands" | "fakeAgent" | "sandboxPath">,
  probe: HarnessProbe = harnessProbe(config.sandboxPath),
): ReadonlyArray<HarnessStatus> =>
  MODEL_PROVIDERS.filter((provider) => provider.standalone === true).map((provider) => {
    const harness = provider.id as AcpHarnessId
    if (config.fakeAgent) {
      return { harness, available: false, error: "the fake agent cannot run an ACP harness; start the box without CLOUDAGENTS_FAKE_AGENT" }
    }
    const binary = harnessBinary(config.agentCommands[provider.id])
    if (binary === null) {
      return { harness, available: false, error: `${provider.name} has no command configured on this box` }
    }
    const path = probe.which(binary)
    if (path === null) {
      return { harness, available: false, error: `its CLI (${binary}) is not installed on this box` }
    }
    // A harness built against a protocol version cannot run an older CLI (OpenCode 1 is its own line; agy signs in
    // from a terminal only from 1.5).
    const minVersion = MODEL_HARNESS[provider.id].minVersion
    if (minVersion !== null) {
      const found = /(\d+)\.(\d+)/.exec(probe.version(path))
      const [needMajor, needMinor] = minVersion
      const usable =
        found !== null &&
        (Number(found[1]) > needMajor || (Number(found[1]) === needMajor && Number(found[2]) >= needMinor))
      if (!usable) {
        return { harness, available: false, error: `its CLI (${binary}) must be version ${needMajor}.${needMinor} or newer` }
      }
    }
    return { harness, available: true }
  })

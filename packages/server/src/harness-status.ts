import { MODEL_PROVIDERS, type AcpHarnessId, type HarnessStatus } from "@cloudagents/protocol"
import { harnessAvailability, harnessProbe, type HarnessProbe } from "./capabilities"
import type { ServerConfig } from "./config"

/**
 * Which standalone ACP harnesses this box can launch (OpenCode, OMP, Pi, Hermes). Their CLIs are host binaries a run
 * starts from PATH, so a harness whose CLI is not installed, or is older than the version its harness needs, can never
 * run: the box says so instead of offering it.
 */

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
    const availability = harnessAvailability(provider.id, config, probe)
    return availability.available
      ? { harness, available: true }
      : { harness, available: false, error: availability.error ?? `${provider.name} cannot run on this box` }
  })

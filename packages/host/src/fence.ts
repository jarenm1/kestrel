import type { HostConfig } from "./config"
import { HostError, errorMessage } from "./errors"
import { readLeaseUntil } from "./lease"
import { sleep } from "./proc"
import { stateLayout } from "./state-store"
import { runChecked, runTool } from "./tools"

/** How often the watchdog checks the lease. */
const FENCE_CHECK_MS = 1_000

/**
 * The fence watchdog: a process separate from the host agent. While the control plane's lease is missing or past its
 * `validUntil` (the agent writes that file before it acts on a lease), every VM scope on this host is killed. It names
 * only `kestrel-vm-*.scope` units, never `kestrel.slice` or any other unit.
 */
export const runFence = async (config: HostConfig): Promise<void> => {
  if (config.scope === "none") throw new HostError("the fence watchdog needs systemd: scope is none")
  const leasePath = stateLayout(config.stateDir).leasePath
  const scopeArgs = config.scope === "systemd-user" ? ["--user"] : []
  for (;;) {
    const validUntil = readLeaseUntil(leasePath)
    if (validUntil === null || Date.now() >= validUntil) await killVmScopes(scopeArgs)
    await sleep(FENCE_CHECK_MS)
  }
}

/** Kills every active VM scope with SIGKILL. A failure is reported and retried on the next check. */
const killVmScopes = async (scopeArgs: readonly string[]): Promise<void> => {
  try {
    const listed = await runChecked("systemctl", [
      ...scopeArgs,
      "list-units",
      "--plain",
      "--no-legend",
      "--no-pager",
      "kestrel-vm-*.scope",
    ])
    const units = listed
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((unit) => unit.startsWith("kestrel-vm-") && unit.endsWith(".scope"))
    if (units.length === 0) return
    const result = await runTool("systemctl", [...scopeArgs, "kill", "--kill-whom=all", "--signal=SIGKILL", ...units])
    if (result.status !== 0) process.stderr.write(`kestrel-host fence: kill failed: ${result.stderr.trim()}\n`)
  } catch (error) {
    process.stderr.write(`kestrel-host fence: ${errorMessage(error)}\n`)
  }
}

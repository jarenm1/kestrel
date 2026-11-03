#!/usr/bin/env bun
import { resolve } from "node:path"
import { parseCommand, USAGE, type Command } from "./args"
import { HostError, UsageError } from "./errors"
import { DEFAULT_LAUNCHER } from "./launcher"
import { reconcileAll, type ReconcileChange } from "./reconcile"
import { initHost, listVmIds, readVm, requireVm, resolveStateDir } from "./state-store"
import { createVm, destroyVm, startVm, stopVm, type StopOutcome } from "./vm"
import type { HostContext } from "./vm-state"

const READY_TIMEOUT_MS = 5000

const STOP_LABEL: Record<StopOutcome, string> = {
  "already-stopped": "already stopped",
  stopped: "stopped",
  forced: "stopped (forced)",
}

export const contextFromEnv = (env: NodeJS.ProcessEnv): HostContext => ({
  stateDir: resolve(resolveStateDir(env)),
  launcher: env.KESTREL_HOST_LAUNCHER ?? DEFAULT_LAUNCHER,
  accel: env.KESTREL_VM_ACCEL ?? "auto",
  readyTimeoutMs: READY_TIMEOUT_MS,
  env,
  warn: (message) => process.stderr.write(`${message}\n`),
})

const describeChange = (change: ReconcileChange): string =>
  `reconcile: ${change.vmId} ${change.from} -> ${change.to} (${change.reason})`

/** Runs one command and returns its stdout text. Throws HostError for operational failures. */
const run = async (command: Command, ctx: HostContext): Promise<string> => {
  if (command.kind === "init") return `${initHost(ctx.stateDir).hostId}\n`
  initHost(ctx.stateDir)
  const changes = await reconcileAll(ctx)
  for (const change of changes) ctx.warn(describeChange(change))
  switch (command.kind) {
    case "reconcile":
      return JSON.stringify(changes, null, 2) + "\n"
    case "create":
      return `${createVm(ctx, command)}\n`
    case "start": {
      const vm = await startVm(ctx, command.vmId)
      return `running ${vm.vmId} pid ${vm.process?.pid}\n`
    }
    case "stop": {
      const outcome = await stopVm(ctx, command.vmId, { timeoutMs: command.timeoutMs, force: command.force })
      return `${STOP_LABEL[outcome]} ${command.vmId}\n`
    }
    case "destroy":
      await destroyVm(ctx, command.vmId)
      return `deleted ${command.vmId}\n`
    case "list": {
      const vms = listVmIds(ctx.stateDir).flatMap((vmId) => {
        const vm = readVm(ctx.stateDir, vmId)
        return vm === null ? [] : [vm]
      })
      return JSON.stringify(vms, null, 2) + "\n"
    }
    case "show":
      return JSON.stringify(requireVm(ctx.stateDir, command.vmId), null, 2) + "\n"
  }
}

/** Entry used by main and tests. Returns the process exit code: 0 ok, 1 operational error, 2 usage error. */
export const runCli = async (argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> => {
  let command: Command
  try {
    command = parseCommand(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`kestrel-host: ${error.message}\n${USAGE}`)
      return error.exitCode
    }
    throw error
  }
  try {
    process.stdout.write(await run(command, contextFromEnv(env)))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`kestrel-host: ${message}\n`)
    return error instanceof HostError ? error.exitCode : 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), process.env)
}

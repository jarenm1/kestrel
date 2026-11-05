#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { runDaemon } from "./daemon"
import { HostError, UsageError, errorMessage } from "./errors"
import { loadConfig } from "./config"
import { runFence } from "./fence"

const DEFAULT_CONFIG = "/etc/kestrel-host/config.json"
const DEFAULT_SOCKET = "/run/kestrel-host/operator.sock"

const USAGE = `usage:
  kestrel-host daemon [--config <file>]            run the host agent (default ${DEFAULT_CONFIG})
  kestrel-host fence [--config <file>]             kill VMs while the control plane's lease has lapsed (run as its own unit)
  kestrel-host vm list [--socket <path>]           list the VMs on this host
  kestrel-host vm show <boxId> [--socket <path>]   show one VM
  kestrel-host vm suspend|park|destroy <boxId> [--socket <path>]
`

const OPTIONS = {
  config: { type: "string" },
  socket: { type: "string" },
} as const

const parse = (argv: readonly string[]) => {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(`${errorMessage(error)}\n${USAGE}`)
  }
}

/** One request to the local API. Every route answers JSON. */
const callApi = async (socket: string, method: string, path: string): Promise<{ status: number; body: unknown }> => {
  let response: Response
  try {
    response = await fetch(`http://localhost${path}`, { method, unix: socket })
  } catch (error) {
    throw new HostError(`cannot reach the host agent at ${socket}: ${errorMessage(error)}`)
  }
  return { status: response.status, body: await response.json() }
}

/** The message of an API error body `{ error }`, or the status when the body has none. */
const apiFailure = (status: number, body: unknown): HostError => {
  const message = typeof body === "object" && body !== null && "error" in body ? body.error : undefined
  return new HostError(typeof message === "string" ? message : `host agent answered ${status}`)
}

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const runVm = async (args: readonly string[], socket: string): Promise<number> => {
  const [action, boxId] = args
  if (action === "list" && args.length === 1) {
    const { status, body } = await callApi(socket, "GET", "/v1/vms")
    if (status !== 200) throw apiFailure(status, body)
    printJson(body)
    return 0
  }
  if (action === "show" && boxId !== undefined && args.length === 2) {
    const { status, body } = await callApi(socket, "GET", `/v1/boxes/${encodeURIComponent(boxId)}`)
    if (status !== 200) throw apiFailure(status, body)
    printJson(body)
    return 0
  }
  if ((action === "suspend" || action === "park" || action === "destroy") && boxId !== undefined && args.length === 2) {
    const { status, body } = await callApi(socket, "POST", `/v1/boxes/${encodeURIComponent(boxId)}/${action}`)
    if (status === 404) throw apiFailure(status, body)
    printJson(body)
    return status === 200 ? 0 : 1
  }
  throw new UsageError(USAGE)
}

/** Runs one CLI invocation and returns the process exit code: 0 ok, 1 operation failed, 2 usage. */
export const runCli = async (argv: readonly string[]): Promise<number> => {
  try {
    const { values, positionals } = parse(argv)
    const [command, ...rest] = positionals
    if (command === "daemon" && rest.length === 0) {
      await runDaemon(values.config ?? DEFAULT_CONFIG)
      return 0
    }
    if (command === "fence" && rest.length === 0) {
      await runFence(loadConfig(values.config ?? DEFAULT_CONFIG))
      return 0
    }
    if (command === "vm") return await runVm(rest, values.socket ?? DEFAULT_SOCKET)
    throw new UsageError(USAGE)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(error.message.endsWith("\n") ? error.message : `${error.message}\n`)
      return error.exitCode
    }
    process.stderr.write(`kestrel-host: ${errorMessage(error)}\n`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2))

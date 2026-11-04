import type { Subprocess } from "bun"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { HostError } from "./errors"

/** Throws HostError unless `name` is an executable on PATH. */
export const requireTool = (name: string): void => {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  for (const dir of dirs) {
    try {
      accessSync(join(dir, name), constants.X_OK)
      if (statSync(join(dir, name)).isFile()) return
    } catch {
      // not in this PATH entry; keep looking
    }
  }
  throw new HostError(`required tool not found on PATH: ${name}`)
}

export interface ToolResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a tool to completion without blocking the event loop, capturing output. Does not throw on a non-zero exit. */
export const runTool = async (name: string, args: readonly string[]): Promise<ToolResult> => {
  requireTool(name)
  let child: Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn([name, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    throw new HostError(`${name} failed to run: ${(error as Error).message}`)
  }
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, stdout, stderr }
}

/** Runs a tool and returns its stdout; throws HostError with the tool's stderr on a non-zero exit. */
export const runChecked = async (name: string, args: readonly string[]): Promise<string> => {
  const result = await runTool(name, args)
  if (result.status !== 0) {
    throw new HostError(`${name} ${args[0] ?? ""} exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`)
  }
  return result.stdout
}

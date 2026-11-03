import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"
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
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a tool to completion, capturing output. Does not throw on a non-zero exit. */
export const runTool = (name: string, args: readonly string[]): ToolResult => {
  requireTool(name)
  const result = spawnSync(name, [...args], { encoding: "utf8" })
  if (result.error !== undefined) throw new HostError(`${name} failed to run: ${result.error.message}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

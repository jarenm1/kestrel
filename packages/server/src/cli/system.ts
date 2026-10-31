import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { createServer } from "node:net"
import { delimiter, join } from "node:path"

/** A failure the user should see as a message, not a stack trace. */
export class CliError extends Error {}

export interface Exec {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs a command and captures its output; a command that cannot start reports `status: null`. */
export const exec = (cmd: string, args: readonly string[], timeoutMs = 30_000): Exec => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** Runs a command attached to this terminal and returns its exit code. */
export const execInherit = (cmd: string, args: readonly string[]): number => {
  const r = spawnSync(cmd, args, { stdio: "inherit" })
  if (r.error) throw new CliError(`${cmd}: ${r.error.message}`)
  return r.status ?? 1
}

/** Path of an executable on PATH, or null. */
export const onPath = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK)
        return candidate
      }
    } catch {
      // not here; keep looking
    }
  }
  return null
}

export const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path

export const isWsl = (): boolean => {
  if (process.env.WSL_DISTRO_NAME !== undefined) return true
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"))
  } catch {
    return false
  }
}

export const systemdIsPid1 = (): boolean => {
  try {
    return readFileSync("/proc/1/comm", "utf8").trim() === "systemd"
  } catch {
    return false
  }
}

/** True when nothing is listening on `port` (binds and immediately releases it). */
export const portFree = (port: number, host = "127.0.0.1"): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const server = createServer()
  server.once("error", () => resolve(false))
  server.listen(port, host, () => server.close(() => resolve(true)))
  return promise
}

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Opens a URL in the desktop browser when this session has one; failures are ignored. */
export const openBrowser = (url: string): void => {
  let opener: string | null = null
  if (process.platform === "darwin") opener = "open"
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) opener = "xdg-open"
  if (opener === null) return
  const child = spawn(opener, [url], { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

/** Whether this process is the compiled single-file binary (not `bun run`). */
export const isCompiledBinary = (): boolean =>
  import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN")

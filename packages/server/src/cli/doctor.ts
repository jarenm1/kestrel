import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boxHomeToolArgs, cliBwrapArgs } from "../sandbox"
import { DEFAULT_CONFIG, loadConfig } from "./config"
import type { BoxConfig } from "./config"
import { DESKTOP_TOOLS, desktopHelperPath } from "./desktop"
import { exec, onPath, portFree } from "./system"

export const SERVICE_NAME = "kestrel-box.service"

export interface Check {
  readonly name: string
  readonly required: boolean
  readonly ok: boolean
  readonly detail: string
}

/** Checks for a Linux host (native, or WSL with systemd). Required checks gate `install`. */
export const linuxChecks = async (): Promise<readonly Check[]> => {
  const checks: Check[] = []

  let config: BoxConfig | null = null
  try {
    config = loadConfig()
    if (config === null) checks.push({ name: "config", required: true, ok: false, detail: "missing; run kestrel-box login" })
    else if (config.boxId === "") checks.push({ name: "config", required: true, ok: false, detail: "not paired; run kestrel-box login" })
    else checks.push({ name: "config", required: true, ok: true, detail: `paired as box ${config.boxId}` })
  } catch (error) {
    checks.push({ name: "config", required: true, ok: false, detail: (error as Error).message })
  }

  const systemd = exec("systemctl", ["--user", "show-environment"])
  checks.push({
    name: "systemd user manager",
    required: true,
    ok: systemd.status === 0,
    detail:
      systemd.status === 0
        ? "reachable"
        : "not reachable (on WSL, enable systemd in /etc/wsl.conf with [boot] systemd=true)",
  })

  const bwrap = exec("bwrap", ["--ro-bind", "/", "/", "true"])
  checks.push({
    name: "bubblewrap",
    required: true,
    ok: bwrap.status === 0,
    detail:
      bwrap.status === 0
        ? "sandbox works"
        : `cannot run bwrap: ${bwrap.stderr.trim() || "not installed"} (sudo apt install bubblewrap; Ubuntu 24.04 may also need an AppArmor profile for bwrap)`,
  })

  checks.push({
    name: "git",
    required: true,
    ok: onPath("git") !== null,
    detail: onPath("git") ?? "not installed (sudo apt install git)",
  })

  // On PATH is not enough: the CLI must start inside the sandbox the box runs it in (which hides $HOME apart from the
  // agent CLIs it finds there).
  const sandboxed = (config ?? DEFAULT_CONFIG).sandbox === "basic"
  const home = mkdtempSync(join(tmpdir(), "kestrel-doctor-"))
  const agents = ["claude", "codex"].map((name) => {
    if (onPath(name) === null) return { name, ok: false, detail: "not on PATH" }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
    const run = sandboxed
      ? exec("bwrap", cliBwrapArgs(home, env, [name, "--version"], {
          level: "basic",
          homeToolArgs: boxHomeToolArgs(),
          network: "none",
        }))
      : exec(name, ["--version"])
    const output = `${run.stdout}${run.stderr}`.trim().split("\n")[0] ?? ""
    return { name, ok: run.status === 0, detail: output || `exit ${run.status ?? "?"}` }
  })
  rmSync(home, { recursive: true, force: true })
  for (const agent of agents) {
    checks.push({ name: `${agent.name}${sandboxed ? " (in sandbox)" : ""}`, required: false, ok: agent.ok, detail: agent.detail })
  }
  checks.push({
    name: "agent CLI",
    required: true,
    ok: agents.some((agent) => agent.ok),
    detail: agents.some((agent) => agent.ok)
      ? agents.filter((agent) => agent.ok).map((agent) => agent.name).join(", ")
      : "neither claude nor codex runs (install one: https://docs.anthropic.com/claude-code, npm i -g @openai/codex)",
  })

  const port = (config ?? DEFAULT_CONFIG).port
  const service = exec("systemctl", ["--user", "is-active", SERVICE_NAME])
  const serviceActive = service.status === 0 && service.stdout.trim() === "active"
  const free = await portFree(port)
  checks.push({
    name: `port ${port}`,
    required: true,
    ok: free || serviceActive,
    detail: free ? "free" : serviceActive ? `in use by ${SERVICE_NAME}` : "in use by another process",
  })

  for (const tool of DESKTOP_TOOLS) {
    const found = onPath(tool)
    if (tool === "weston" && found !== null) {
      checks.push(westonCheck(found))
      continue
    }
    checks.push({
      name: tool,
      required: false,
      ok: found !== null,
      detail: found ?? "not installed (optional; needed for desktop runs)",
    })
  }
  const helper = existsSync(desktopHelperPath()) || onPath("xdamage-capture") !== null
  checks.push({
    name: "xdamage-capture",
    required: false,
    ok: helper,
    detail: helper ? "installed" : "not built (optional; needed for desktop runs)",
  })

  return checks
}

/** The desktop starts Xwayland as weston's client (`weston … -- Xwayland …`), which weston supports from 14.0. */
const MIN_WESTON_MAJOR = 14

const westonCheck = (path: string): Check => {
  const run = exec(path, ["--version"])
  const version = /weston (\d+)\.\S*/.exec(run.stdout + run.stderr)
  if (version === null) return { name: "weston", required: false, ok: false, detail: `${path}: version unknown` }
  const ok = Number(version[1]) >= MIN_WESTON_MAJOR
  return {
    name: "weston",
    required: false,
    ok,
    detail: ok
      ? `${path} (${version[0]})`
      : `${path} is ${version[0]}; desktop runs need weston ${MIN_WESTON_MAJOR} or newer (e.g. \`nix profile install nixpkgs#weston\`)`,
  }
}

/** Prints each check and returns whether every required check passed. */
export const printChecks = (checks: readonly Check[]): boolean => {
  for (const check of checks) {
    const label = check.ok ? "ok  " : check.required ? "FAIL" : "warn"
    console.log(`${label} ${check.name}: ${check.detail}`)
  }
  return checks.every((check) => !check.required || check.ok)
}

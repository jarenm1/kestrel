import { existsSync } from "node:fs"
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

  const agents = ["claude", "codex"].filter((name) => onPath(name) !== null)
  checks.push({
    name: "agent CLI",
    required: true,
    ok: agents.length > 0,
    detail: agents.length > 0 ? agents.join(", ") : "neither claude nor codex is on PATH",
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

/** Prints each check and returns whether every required check passed. */
export const printChecks = (checks: readonly Check[]): boolean => {
  for (const check of checks) {
    const label = check.ok ? "ok  " : check.required ? "FAIL" : "warn"
    console.log(`${label} ${check.name}: ${check.detail}`)
  }
  return checks.every((check) => !check.required || check.ok)
}

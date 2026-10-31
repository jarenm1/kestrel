import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { join, resolve } from "node:path"
import { configDir, loadConfig, xdgConfigHome } from "./config"
import { buildDesktopHelper, desktopBinDir } from "./desktop"
import { linuxChecks, printChecks, SERVICE_NAME } from "./doctor"
import { CliError, exec, expandHome, isCompiledBinary, isWsl, systemdIsPid1, sleep } from "./system"

export const installDir = (): string => join(homedir(), ".local", "bin")
export const installedBinary = (): string => join(installDir(), "kestrel-box")
export const unitPath = (): string => join(xdgConfigHome(), "systemd", "user", SERVICE_NAME)

/** Quotes one systemd value: escapes `\`, `"`, `%` (specifier) and `$` (variable expansion). */
const systemdQuote = (value: string): string =>
  `"${value.replace(/[\\"%$]/g, (c) => (c === "%" || c === "$" ? `${c}${c}` : `\\${c}`))}"`

export const unitText = (binary: string, path: string): string =>
  [
    "[Unit]",
    "Description=Kestrel box",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${systemdQuote(binary)} run`,
    `Environment=${systemdQuote(`PATH=${path}`)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")

const isActive = (): boolean => {
  const r = exec("systemctl", ["--user", "is-active", SERVICE_NAME])
  return r.status === 0 && r.stdout.trim() === "active"
}

const requireSystemctl = (args: readonly string[]): void => {
  const r = exec("systemctl", ["--user", ...args])
  if (r.status !== 0) throw new CliError(`systemctl --user ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`)
}

/** Polls the box's own health endpoint for a short while after start; false if it never answers. */
const waitHealthy = async (port: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null)
    if (response?.ok) return true
    await sleep(500)
  }
  return false
}

export const installLinux = async (): Promise<void> => {
  if (!isCompiledBinary()) {
    throw new CliError("install runs from the compiled binary; build it with `bun run build:box` and run dist/box/kestrel-box-<os>-<arch> install")
  }
  if (isWsl() && !systemdIsPid1()) {
    throw new CliError(
      "WSL is not running systemd. Add to /etc/wsl.conf:\n  [boot]\n  systemd=true\nthen run `wsl --shutdown` from Windows and try again.",
    )
  }

  const checks = await linuxChecks()
  if (!printChecks(checks)) throw new CliError("required checks failed; fix them and run install again")

  const binary = installedBinary()
  if (resolve(process.execPath) !== binary) {
    mkdirSync(installDir(), { recursive: true })
    const staged = `${binary}.new`
    copyFileSync(process.execPath, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, binary)
    console.log(`installed ${binary}`)
  }

  try {
    buildDesktopHelper()
    console.log(`built desktop helper in ${desktopBinDir()}`)
  } catch (error) {
    console.warn(`warn desktop helper not built (desktop runs will not work): ${(error as Error).message}`)
  }

  const path = [desktopBinDir(), installDir(), process.env.PATH ?? ""].join(":")
  const unit = unitPath()
  mkdirSync(join(unit, ".."), { recursive: true })
  const staged = `${unit}.new`
  writeFileSync(staged, unitText(binary, path))
  renameSync(staged, unit)
  console.log(`wrote ${unit}`)

  const wasActive = isActive()
  requireSystemctl(["daemon-reload"])
  requireSystemctl(["enable", "--now", SERVICE_NAME])
  if (wasActive) requireSystemctl(["restart", SERVICE_NAME])

  const linger = exec("loginctl", ["enable-linger", userInfo().username])
  if (linger.status !== 0) {
    console.warn(
      `warn could not enable linger; the box stops at logout. Run: sudo loginctl enable-linger ${userInfo().username}`,
    )
  }

  const config = loadConfig()
  if (config === null) throw new CliError("config disappeared during install")
  const port = config.port
  if (await waitHealthy(port)) console.log(`kestrel-box is running on port ${port}`)
  else console.warn(`warn kestrel-box did not answer on port ${port}; see: systemctl --user status ${SERVICE_NAME}`)
}

export const uninstallLinux = (purge: boolean): void => {
  // Stopping waits for the box to shut down, which systemd bounds at its stop timeout (90 s by default).
  const disabled = exec("systemctl", ["--user", "disable", "--now", SERVICE_NAME], 120_000)
  if (disabled.status === null) throw new CliError(`systemctl --user disable --now ${SERVICE_NAME} did not finish`)
  if (disabled.status !== 0) console.log(`service was not enabled (${disabled.stderr.trim() || "no unit"})`)
  else console.log(`stopped and disabled ${SERVICE_NAME}`)

  const unit = unitPath()
  if (existsSync(unit)) rmSync(unit)
  console.log(`removed ${unit}`)
  requireSystemctl(["daemon-reload"])

  if (!purge) return
  // The configured data dir, not a fixed path: on Kestrel's own machines `~/.local/share/kestrel-box` is box-auto's
  // production checkout, so nothing here may assume a directory it did not make.
  const config = loadConfig()
  if (config !== null) rmSync(expandHome(config.dataDir), { recursive: true, force: true })
  rmSync(desktopBinDir(), { recursive: true, force: true })
  rmSync(configDir(), { recursive: true, force: true })
  rmSync(installedBinary(), { force: true })
  console.log("purged config, data, the desktop helper and the installed binary")
}


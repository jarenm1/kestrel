import { Schema } from "effect"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { VERSION } from "../config"
import { configDir, configPath, loadConfig } from "./config"
import { printChecks } from "./doctor"
import type { Check } from "./doctor"
import { CliError, exec, execInherit, onPath } from "./system"

const VM = "kestrel-box"
const UBUNTU = "https://cloud-images.ubuntu.com/releases/24.04/release"

const LimaVm = Schema.Struct({ name: Schema.String, status: Schema.String })

/** Status of the Lima VM this box runs in, or null when it does not exist. */
const vmStatus = (): string | null => {
  const r = exec("limactl", ["list", "--json"])
  if (r.status !== 0) throw new CliError(`limactl list failed: ${r.stderr.trim()}`)
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue
    const vm = Schema.decodeUnknownSync(LimaVm)(JSON.parse(line))
    if (vm.name === VM) return vm.status
  }
  return null
}

const requireLima = (): void => {
  if (onPath("limactl") === null) throw new CliError("Lima is required on macOS: brew install lima")
}

/** Guest architecture follows the host's; the box binary is the matching linux build. */
const guestArch = (): { readonly lima: "aarch64" | "x86_64"; readonly binary: "arm64" | "x64" } => {
  if (process.arch === "arm64") return { lima: "aarch64", binary: "arm64" }
  if (process.arch === "x64") return { lima: "x86_64", binary: "x64" }
  throw new CliError(`unsupported host architecture: ${process.arch}`)
}

const limaYaml = (cpus: number, memoryGiB: number, port: number, lima: "aarch64" | "x86_64"): string => {
  const image = lima === "aarch64" ? "arm64" : "amd64"
  return [
    "vmType: vz",
    `arch: ${lima}`,
    "images:",
    `  - location: "${UBUNTU}/ubuntu-24.04-server-cloudimg-${image}.img"`,
    `    arch: "${lima}"`,
    `cpus: ${cpus}`,
    `memory: "${memoryGiB}GiB"`,
    'disk: "40GiB"',
    "mounts: []",
    "containerd:",
    "  system: false",
    "  user: false",
    "portForwards:",
    `  - guestPort: ${port}`,
    `    hostPort: ${port}`,
    "",
  ].join("\n")
}

const downloadLinuxBinary = async (arch: "arm64" | "x64"): Promise<string> => {
  const url = `https://github.com/jarenm1/kestrel/releases/download/box-v${VERSION}/kestrel-box-linux-${arch}`
  const response = await fetch(url)
  if (!response.ok) throw new CliError(`downloading ${url} failed: ${response.status}`)
  const dir = mkdtempSync(join(tmpdir(), "kestrel-box-"))
  const path = join(dir, "kestrel-box")
  writeFileSync(path, Buffer.from(await response.arrayBuffer()))
  chmodSync(path, 0o755)
  return path
}

const PROVISION = [
  "set -e",
  "export DEBIAN_FRONTEND=noninteractive",
  "apt-get update",
  // The box and its sandbox, the agent CLIs' runtime, and the desktop session with what `install` needs to build
  // its capture helper.
  "apt-get install -y bubblewrap git curl ca-certificates nodejs npm weston xwayland openbox hsetroot xterm xdotool ffmpeg build-essential libx11-dev libxext-dev libxdamage-dev libxfixes-dev",
  "npm install -g @anthropic-ai/claude-code @openai/codex",
].join("\n")

const PLACE = [
  "set -e",
  'mkdir -p "$HOME/.local/bin" "$HOME/.config/kestrel-box"',
  'mv /tmp/kestrel-box-bin "$HOME/.local/bin/.kestrel-box.new"',
  'chmod 755 "$HOME/.local/bin/.kestrel-box.new"',
  'mv -f "$HOME/.local/bin/.kestrel-box.new" "$HOME/.local/bin/kestrel-box"',
  'mv -f /tmp/kestrel-box-config.json "$HOME/.config/kestrel-box/config.json"',
  'chmod 600 "$HOME/.config/kestrel-box/config.json"',
].join("\n")

export interface MacInstallOptions {
  readonly cpus?: number
  readonly memoryGiB?: number
  readonly linuxBinary?: string
}

export const macosInstall = async (options: MacInstallOptions): Promise<void> => {
  requireLima()
  const config = loadConfig()
  if (config === null) throw new CliError(`no config at ${configPath()}; run \`kestrel-box login\` first`)
  if (config.boxId === "") throw new CliError("this machine is not paired yet; run `kestrel-box login` first")

  const arch = guestArch()
  const cpus = options.cpus ?? Math.max(2, Math.floor(availableParallelism() / 2))
  const memoryGiB = options.memoryGiB ?? Math.max(2, Math.floor(totalmem() / 2 ** 30 / 2))
  const binary = options.linuxBinary ?? (await downloadLinuxBinary(arch.binary))

  if (vmStatus() === null) {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-box-lima-"))
    const yaml = join(dir, "kestrel-box.yaml")
    writeFileSync(yaml, limaYaml(cpus, memoryGiB, config.port, arch.lima))
    const created = execInherit("limactl", ["create", "--name", VM, "--tty=false", yaml])
    rmSync(dir, { recursive: true, force: true })
    if (created !== 0) throw new CliError("limactl create failed")
  }
  if (vmStatus() !== "Running" && execInherit("limactl", ["start", "--tty=false", VM]) !== 0) {
    throw new CliError("limactl start failed")
  }

  if (execInherit("limactl", ["shell", "--tty=false", VM, "--", "sudo", "sh", "-c", PROVISION]) !== 0) {
    throw new CliError("provisioning the VM failed")
  }
  if (execInherit("limactl", ["copy", binary, `${VM}:/tmp/kestrel-box-bin`]) !== 0) {
    throw new CliError("copying the binary into the VM failed")
  }
  if (execInherit("limactl", ["copy", configPath(), `${VM}:/tmp/kestrel-box-config.json`]) !== 0) {
    throw new CliError("copying the config into the VM failed")
  }
  if (execInherit("limactl", ["shell", "--tty=false", VM, "--", "sh", "-c", PLACE]) !== 0) {
    throw new CliError("placing the binary and config in the VM failed")
  }
  if (execInherit("limactl", ["shell", "--tty=false", VM, "--", "sh", "-lc", '"$HOME/.local/bin/kestrel-box" install']) !== 0) {
    throw new CliError("kestrel-box install failed inside the VM")
  }
  console.log(`kestrel-box is running in Lima VM "${VM}" on port ${config.port}`)
}

/** Host-side checks, then the Linux doctor inside the VM when it is running. */
export const macosDoctor = (): boolean => {
  const limactl = onPath("limactl")
  const checks: Check[] = [
    { name: "limactl", required: true, ok: limactl !== null, detail: limactl ?? "missing (brew install lima)" },
  ]

  let configOk = false
  try {
    const config = loadConfig()
    configOk = config !== null && config.boxId !== ""
    checks.push({
      name: "config",
      required: true,
      ok: configOk,
      detail: config === null ? `missing at ${configPath()}` : config.boxId === "" ? "not paired; run kestrel-box login" : `paired as box ${config.boxId}`,
    })
  } catch (error) {
    checks.push({ name: "config", required: true, ok: false, detail: (error as Error).message })
  }

  const status = limactl === null ? null : vmStatus()
  checks.push({
    name: `VM ${VM}`,
    required: true,
    ok: status === "Running",
    detail: status ?? "does not exist; run kestrel-box install",
  })
  const hostOk = printChecks(checks)
  if (status !== "Running") return false
  const inner = execInherit("limactl", ["shell", "--tty=false", VM, "--", "sh", "-lc", '"$HOME/.local/bin/kestrel-box" doctor'])
  return hostOk && inner === 0
}

export interface MacUninstallOptions {
  readonly deleteVm: boolean
  readonly yes: boolean
  readonly purge: boolean
}

export const macosUninstall = (options: MacUninstallOptions): void => {
  requireLima()
  if (options.deleteVm) {
    if (!options.yes) throw new CliError("--delete-vm destroys the VM and everything in it; pass --yes to confirm")
    if (vmStatus() === "Running") execInherit("limactl", ["stop", VM])
    if (vmStatus() !== null && execInherit("limactl", ["delete", "--force", VM]) !== 0) {
      throw new CliError("limactl delete failed")
    }
    console.log(`deleted Lima VM "${VM}"`)
  } else if (vmStatus() === "Running") {
    const command = `"$HOME/.local/bin/kestrel-box" uninstall${options.purge ? " --purge" : ""}`
    if (execInherit("limactl", ["shell", "--tty=false", VM, "--", "sh", "-lc", command]) !== 0) {
      throw new CliError("uninstall inside the VM failed")
    }
  } else {
    console.log(`VM "${VM}" is not running; nothing to uninstall inside it`)
  }

  if (options.purge) {
    rmSync(configDir(), { recursive: true, force: true })
    console.log("purged host config")
  }
}

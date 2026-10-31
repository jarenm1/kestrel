import { parseArgs } from "node:util"
import type { ParseArgsOptionsConfig } from "node:util"
import { VERSION } from "../config"
import { configPath, loadConfig } from "./config"
import { linuxChecks, printChecks, SERVICE_NAME } from "./doctor"
import { installLinux, uninstallLinux } from "./linux"
import { login } from "./login"
import { macosDoctor, macosInstall, macosUninstall } from "./macos"
import { runBox } from "./run"
import { CliError, execInherit } from "./system"

const HELP = `kestrel-box ${VERSION}

Usage: kestrel-box <command> [options]

Commands:
  login        pair this machine with the control plane (--control-url, --name, --url, --force)
  install      install and start the box as a user service (macOS: create the Lima VM)
               macOS options: --cpus N, --memory GiB, --linux-binary PATH
  uninstall    stop and remove the service (macOS: --delete-vm --yes; --purge removes config and data)
  run          run the box in this process (what the service executes)
  status       show whether the service is running (macOS: inside the Lima VM)
  logs         follow the service's log (macOS: inside the Lima VM)
  doctor       check that this machine can run the box
  config       show the config file (secret redacted)
  help         show this message
  --version    print the version
`

const flags = <const O extends ParseArgsOptionsConfig>(args: readonly string[], options: O) => {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: false, strict: true }).values
  } catch (error) {
    throw new CliError((error as Error).message)
  }
}

const positiveInt = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new CliError(`--${flag} must be a positive integer, got "${value}"`)
  return n
}

const command = async (name: string, args: readonly string[]): Promise<void> => {
  switch (name) {
    case "login": {
      const values = flags(args, {
        "control-url": { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        force: { type: "boolean" },
      })
      await login({
        controlUrl: values["control-url"],
        name: values.name,
        url: values.url,
        force: values.force ?? false,
      })
      return
    }
    case "install": {
      if (process.platform === "darwin") {
        const values = flags(args, {
          cpus: { type: "string" },
          memory: { type: "string" },
          "linux-binary": { type: "string" },
        })
        await macosInstall({
          cpus: positiveInt(values.cpus, "cpus"),
          memoryGiB: positiveInt(values.memory, "memory"),
          linuxBinary: values["linux-binary"],
        })
        return
      }
      flags(args, {})
      await installLinux()
      return
    }
    case "uninstall": {
      const values = flags(args, {
        purge: { type: "boolean" },
        "delete-vm": { type: "boolean" },
        yes: { type: "boolean" },
      })
      if (process.platform === "darwin") {
        macosUninstall({ deleteVm: values["delete-vm"] ?? false, yes: values.yes ?? false, purge: values.purge ?? false })
      } else {
        uninstallLinux(values.purge ?? false)
      }
      return
    }
    case "run":
      flags(args, {})
      await runBox()
      return
    case "doctor": {
      flags(args, {})
      const ok = process.platform === "darwin" ? macosDoctor() : printChecks(await linuxChecks())
      if (!ok) process.exitCode = 1
      return
    }
    case "status":
    case "logs": {
      flags(args, {})
      // The service always runs on Linux: here, inside WSL2, or inside the Lima VM on macOS.
      const linux =
        name === "status"
          ? ["systemctl", "--user", "status", "--no-pager", SERVICE_NAME]
          : ["journalctl", "--user", "-u", SERVICE_NAME, "-f", "-n", "100"]
      const code =
        process.platform === "darwin"
          ? execInherit("limactl", ["shell", "--tty=false", "kestrel-box", "--", ...linux])
          : execInherit(linux[0]!, linux.slice(1))
      if (code !== 0) process.exitCode = code
      return
    }
    case "config": {
      flags(args, {})
      const config = loadConfig()
      if (config === null) throw new CliError(`no config at ${configPath()}; run \`kestrel-box login\` first`)
      console.log(configPath())
      console.log(JSON.stringify({ ...config, boxSecret: config.boxSecret === "" ? "" : "<redacted>" }, null, 2))
      return
    }
    default:
      throw new CliError(`unknown command "${name}"\n\n${HELP}`)
  }
}

const [name, ...rest] = process.argv.slice(2)
try {
  if (name === undefined || name === "help" || name === "--help" || name === "-h") console.log(HELP)
  else if (name === "--version" || name === "-v") console.log(VERSION)
  else await command(name, rest)
} catch (error) {
  if (error instanceof CliError) console.error(`kestrel-box: ${error.message}`)
  else console.error(`kestrel-box: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
}

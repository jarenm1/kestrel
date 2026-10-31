import { existsSync } from "node:fs"
import { delimiter } from "node:path"
import { configPath, loadConfig, serverEnv } from "./config"
import { desktopBinDir } from "./desktop"
import { CliError } from "./system"

/** Starts the box in this process: the config becomes the server's environment, then the server loads. */
export const runBox = async (): Promise<void> => {
  const config = loadConfig()
  if (config === null) throw new CliError(`no config at ${configPath()}; run \`kestrel-box login\` first`)
  if (config.boxId === "") throw new CliError("this machine is not paired yet; run `kestrel-box login` first")

  for (const [name, value] of Object.entries(serverEnv(config))) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  const helperDir = desktopBinDir()
  if (existsSync(helperDir)) process.env.PATH = `${helperDir}${delimiter}${process.env.PATH ?? ""}`

  // Static import would run the server as soon as this module loads, before the env above is applied.
  await import("../main")
}

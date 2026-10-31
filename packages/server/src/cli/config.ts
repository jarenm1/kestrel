import { Schema } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { availableParallelism, homedir } from "node:os"
import { dirname, join } from "node:path"
import { CliError, expandHome } from "./system"

const PositiveInt = Schema.Int.pipe(Schema.positive())

export const Provisioning = Schema.Struct({
  mode: Schema.Literal("guaranteed", "pooled", "per-thread"),
  taskMemoryMin: Schema.String,
  taskCpuWeight: PositiveInt,
  taskMemoryMax: Schema.String,
  taskCpuQuota: Schema.String,
  taskTasksMax: PositiveInt,
  taskDiskMax: Schema.String,
  boxMemoryMax: Schema.String,
  boxCpuQuota: Schema.NullOr(Schema.String),
  maxConcurrentRuns: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())),
})

/** The box's config file. `null` box CPU quota / run limit means "size it to this machine" (see `serverEnv`). */
export const BoxConfig = Schema.Struct({
  controlUrl: Schema.String,
  boxId: Schema.String,
  boxSecret: Schema.String,
  port: Schema.Int.pipe(Schema.between(1, 65535)),
  dataDir: Schema.String,
  sandbox: Schema.Literal("basic", "off"),
  provisioning: Provisioning,
})
export type BoxConfig = typeof BoxConfig.Type

/** Shipped default, written by `login` when no config exists yet. boxId/boxSecret are filled by pairing. */
export const DEFAULT_CONFIG: BoxConfig = {
  controlUrl: "https://app.kestrel-agent.com",
  boxId: "",
  boxSecret: "",
  port: 8787,
  dataDir: "~/.local/share/kestrel/box",
  sandbox: "basic",
  provisioning: {
    mode: "guaranteed",
    taskMemoryMin: "1G",
    taskCpuWeight: 100,
    taskMemoryMax: "4G",
    taskCpuQuota: "200%",
    taskTasksMax: 1024,
    taskDiskMax: "50G",
    boxMemoryMax: "80%",
    boxCpuQuota: null,
    maxConcurrentRuns: null,
  },
}

/** `${XDG_CONFIG_HOME:-~/.config}`; a relative XDG value is ignored, as the XDG spec requires. */
export const xdgConfigHome = (): string => {
  const value = process.env.XDG_CONFIG_HOME
  return value !== undefined && value.startsWith("/") ? value : join(homedir(), ".config")
}

export const configDir = (): string => join(xdgConfigHome(), "kestrel-box")
export const configPath = (): string => join(configDir(), "config.json")

/** Reads and validates the config file; null when it does not exist. Malformed config is an error. */
export const loadConfig = (): BoxConfig | null => {
  const path = configPath()
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new CliError(`config ${path} is not valid JSON: ${(error as Error).message}`)
  }
  try {
    return Schema.decodeUnknownSync(BoxConfig)(raw)
  } catch (error) {
    throw new CliError(`config ${path} is invalid: ${(error as Error).message}`)
  }
}

/** Writes the config atomically with mode 600 (it holds the box secret). */
export const writeConfig = (config: BoxConfig): void => {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/**
 * Environment for the server, one entry per variable. The server's own defaults are for Kestrel's shared box, so a
 * user's box always passes its provisioning; `null` box CPU and run limits are sized to this machine here: 80% of the
 * cores for the box, and one agent run per core.
 */
export const serverEnv = (config: BoxConfig): Record<string, string | undefined> => {
  const p = config.provisioning
  const cores = availableParallelism()
  return {
    CLOUDAGENTS_PORT: String(config.port),
    CLOUDAGENTS_DATA_DIR: expandHome(config.dataDir),
    CLOUDAGENTS_SANDBOX: config.sandbox,
    CLOUDAGENTS_PROVISIONING: p.mode,
    CLOUDAGENTS_TASK_MEMORY_MIN: p.taskMemoryMin,
    CLOUDAGENTS_TASK_CPU_WEIGHT: String(p.taskCpuWeight),
    CLOUDAGENTS_TASK_MEMORY_MAX: p.taskMemoryMax,
    CLOUDAGENTS_TASK_CPU_QUOTA: p.taskCpuQuota,
    CLOUDAGENTS_TASK_TASKS_MAX: String(p.taskTasksMax),
    CLOUDAGENTS_TASK_DISK_MAX: p.taskDiskMax,
    CLOUDAGENTS_BOX_MEMORY_MAX: p.boxMemoryMax,
    CLOUDAGENTS_BOX_CPU_QUOTA: p.boxCpuQuota ?? `${Math.max(1, Math.floor(cores * 0.8)) * 100}%`,
    CLOUDAGENTS_MAX_CONCURRENT_RUNS: String(p.maxConcurrentRuns ?? cores),
    CLOUDAGENTS_CONTROL_URL: config.controlUrl,
    CLOUDAGENTS_BOX_ID: config.boxId,
    CLOUDAGENTS_BOX_SECRET: config.boxSecret,
  }
}

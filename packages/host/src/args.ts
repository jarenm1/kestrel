import { parseArgs, type ParseArgsConfig } from "node:util"
import { Schema } from "effect"
import { UsageError } from "./errors"
import { Identifier, Uuid, type Shape } from "./schema"

export type Command =
  | { readonly kind: "init" }
  | {
      readonly kind: "create"
      readonly userId: string
      readonly osImage: string
      readonly shape: Shape
      readonly volumeGb: number
    }
  | { readonly kind: "start"; readonly vmId: string }
  | { readonly kind: "stop"; readonly vmId: string; readonly timeoutMs: number; readonly force: boolean }
  | { readonly kind: "destroy"; readonly vmId: string }
  | { readonly kind: "list" }
  | { readonly kind: "show"; readonly vmId: string }
  | { readonly kind: "reconcile" }

export const USAGE = `usage:
  kestrel-host init
  kestrel-host vm create --user <userId> --os-image <raw path> [--cpus N=2 (1-8)] [--memory-mb N=2048 (max 4096)] [--volume-gb N=20]
  kestrel-host vm start <vmId>
  kestrel-host vm stop <vmId> [--timeout SECONDS=120] [--force]
  kestrel-host vm destroy <vmId> --yes
  kestrel-host vm list
  kestrel-host vm show <vmId>
  kestrel-host reconcile
`

interface Flags {
  readonly values: Record<string, string | boolean | undefined>
  readonly positionals: string[]
}

const parseFlags = (args: readonly string[], options: NonNullable<ParseArgsConfig["options"]>): Flags => {
  try {
    const parsed = parseArgs({ args: [...args], options, strict: true, allowPositionals: true })
    return { values: parsed.values as Flags["values"], positionals: parsed.positionals }
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

const requireNoArgs = (flags: Flags): void => {
  if (flags.positionals.length > 0) throw new UsageError(`unexpected argument: ${flags.positionals[0]}`)
}

const requireVmIdArg = (flags: Flags): string => {
  if (flags.positionals.length !== 1) throw new UsageError("expected exactly one <vmId>")
  const vmId = flags.positionals[0] ?? ""
  if (!Schema.is(Uuid)(vmId)) throw new UsageError(`not a VM id (UUID v4): ${vmId}`)
  return vmId
}

const intFlag = (value: string | boolean | undefined, fallback: number, name: string, min: number, max: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new UsageError(`--${name} must be an integer`)
  const parsed = Number(value)
  if (parsed < min || parsed > max) throw new UsageError(`--${name} must be between ${min} and ${max}`)
  return parsed
}

const stringFlag = (value: string | boolean | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new UsageError(`--${name} requires a value`)
  return value
}

const parseVmCommand = (sub: string | undefined, rest: readonly string[]): Command => {
  switch (sub) {
    case "create": {
      const flags = parseFlags(rest, {
        user: { type: "string" },
        "os-image": { type: "string" },
        cpus: { type: "string" },
        "memory-mb": { type: "string" },
        "volume-gb": { type: "string" },
      })
      requireNoArgs(flags)
      const userId = stringFlag(flags.values.user, "user")
      const osImage = stringFlag(flags.values["os-image"], "os-image")
      if (userId === undefined || osImage === undefined) throw new UsageError("create requires --user and --os-image")
      if (!Schema.is(Identifier)(userId)) throw new UsageError(`invalid --user: ${userId}`)
      return {
        kind: "create",
        userId,
        osImage,
        shape: {
          cpus: intFlag(flags.values.cpus, 2, "cpus", 1, 8),
          memoryMb: intFlag(flags.values["memory-mb"], 2048, "memory-mb", 128, 4096),
        },
        volumeGb: intFlag(flags.values["volume-gb"], 20, "volume-gb", 1, 4096),
      }
    }
    case "start":
      return { kind: "start", vmId: requireVmIdArg(parseFlags(rest, {})) }
    case "stop": {
      const flags = parseFlags(rest, { timeout: { type: "string" }, force: { type: "boolean" } })
      return {
        kind: "stop",
        vmId: requireVmIdArg(flags),
        timeoutMs: intFlag(flags.values.timeout, 120, "timeout", 1, 86400) * 1000,
        force: flags.values.force === true,
      }
    }
    case "destroy": {
      const flags = parseFlags(rest, { yes: { type: "boolean" } })
      const vmId = requireVmIdArg(flags)
      if (flags.values.yes !== true) throw new UsageError("destroy requires --yes")
      return { kind: "destroy", vmId }
    }
    case "list":
      requireNoArgs(parseFlags(rest, {}))
      return { kind: "list" }
    case "show":
      return { kind: "show", vmId: requireVmIdArg(parseFlags(rest, {})) }
    default:
      throw new UsageError(sub === undefined ? "missing vm subcommand" : `unknown vm subcommand: ${sub}`)
  }
}

/** Parses argv (without node/script). Throws UsageError on any malformed input. */
export const parseCommand = (argv: readonly string[]): Command => {
  const [group, sub, ...rest] = argv
  switch (group) {
    case undefined:
      throw new UsageError("missing command")
    case "init":
      requireNoArgs(parseFlags(argv.slice(1), {}))
      return { kind: "init" }
    case "reconcile":
      requireNoArgs(parseFlags(argv.slice(1), {}))
      return { kind: "reconcile" }
    case "vm":
      return parseVmCommand(sub, rest)
    default:
      throw new UsageError(`unknown command: ${group}`)
  }
}

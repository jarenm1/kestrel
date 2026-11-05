/**
 * Command-line parsing with the semantics of spf13/pflag as the GitHub CLI configures it: flags may appear anywhere
 * among the arguments, `--` ends them, a long flag takes `--name=value` or `--name value` (the next argument even
 * when it starts with `-`), short flags combine (`-dw`, `-tTitle`, `-t=Title`), string slices split on commas
 * (CSV quoting) and accumulate, and string arrays accumulate each value whole. Error texts are pflag's, byte for byte.
 */

export type FlagKind =
  | { readonly type: "bool" }
  | { readonly type: "string" }
  | { readonly type: "stringSlice" }
  | { readonly type: "stringArray" }
  | { readonly type: "int" }
  | { readonly type: "enum"; readonly values: ReadonlyArray<string> }

export interface FlagSpec {
  readonly long: string
  readonly short?: string
  readonly kind: FlagKind
}

export const bool = (long: string, short?: string): FlagSpec => ({ long, short, kind: { type: "bool" } })
export const str = (long: string, short?: string): FlagSpec => ({ long, short, kind: { type: "string" } })
export const slice = (long: string, short?: string): FlagSpec => ({ long, short, kind: { type: "stringSlice" } })
export const array = (long: string, short?: string): FlagSpec => ({ long, short, kind: { type: "stringArray" } })
export const int = (long: string, short?: string): FlagSpec => ({ long, short, kind: { type: "int" } })
export const oneOf = (long: string, short: string | undefined, values: ReadonlyArray<string>): FlagSpec => ({
  long,
  short,
  kind: { type: "enum", values },
})

/** What the user set; a flag absent from `changed` was not given. */
export interface ParsedFlags {
  readonly changed: ReadonlySet<string>
  readonly values: ReadonlyMap<string, string | boolean | number | ReadonlyArray<string>>
  readonly args: ReadonlyArray<string>
}

export class FlagParseError extends Error {}

const flagName = (spec: FlagSpec): string => (spec.short === undefined ? `--${spec.long}` : `-${spec.short}, --${spec.long}`)

/** Go's encoding/csv reading one record, which is how pflag splits a string-slice value. */
const splitCsv = (value: string): string[] => {
  if (value === "") return []
  const fields: string[] = []
  let i = 0
  while (true) {
    let field = ""
    if (value[i] === '"') {
      i++
      while (i < value.length) {
        if (value[i] === '"') {
          if (value[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i++
          break
        }
        field += value[i]
        i++
      }
      while (i < value.length && value[i] !== ",") field += value[i++]
    } else {
      while (i < value.length && value[i] !== ",") field += value[i++]
    }
    fields.push(field)
    if (i >= value.length) break
    i++
  }
  return fields
}

/** Go's strconv.ParseBool. */
const parseBool = (value: string): boolean | null => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) return true
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) return false
  return null
}

export const parseFlags = (argv: ReadonlyArray<string>, specs: ReadonlyArray<FlagSpec>): ParsedFlags => {
  const byLong = new Map(specs.map((s) => [s.long, s]))
  const byShort = new Map(specs.flatMap((s) => (s.short === undefined ? [] : [[s.short, s] as const])))
  const changed = new Set<string>()
  const values = new Map<string, string | boolean | number | ReadonlyArray<string>>()
  const args: string[] = []

  const set = (spec: FlagSpec, value: string): void => {
    const kind = spec.kind
    switch (kind.type) {
      case "bool": {
        const parsed = parseBool(value)
        if (parsed === null) {
          throw new FlagParseError(
            `invalid argument "${value}" for "${flagName(spec)}" flag: strconv.ParseBool: parsing "${value}": invalid syntax`,
          )
        }
        values.set(spec.long, parsed)
        break
      }
      case "string":
        values.set(spec.long, value)
        break
      case "stringSlice": {
        const previous = changed.has(spec.long) ? (values.get(spec.long) as ReadonlyArray<string>) : []
        values.set(spec.long, [...previous, ...splitCsv(value)])
        break
      }
      case "stringArray": {
        const previous = changed.has(spec.long) ? (values.get(spec.long) as ReadonlyArray<string>) : []
        values.set(spec.long, [...previous, value])
        break
      }
      case "int": {
        if (!/^[+-]?\d+$/.test(value)) {
          throw new FlagParseError(
            `invalid argument "${value}" for "${flagName(spec)}" flag: strconv.ParseInt: parsing "${value}": invalid syntax`,
          )
        }
        values.set(spec.long, Number.parseInt(value, 10))
        break
      }
      case "enum":
        if (!kind.values.includes(value)) {
          throw new FlagParseError(
            `invalid argument "${value}" for "${flagName(spec)}" flag: valid values are {${kind.values.join("|")}}`,
          )
        }
        values.set(spec.long, value)
        break
    }
    changed.add(spec.long)
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "--") {
      args.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const body = arg.slice(2)
      const eq = body.indexOf("=")
      const name = eq === -1 ? body : body.slice(0, eq)
      const spec = byLong.get(name)
      if (spec === undefined) throw new FlagParseError(`unknown flag: --${name}`)
      if (eq !== -1) set(spec, body.slice(eq + 1))
      else if (spec.kind.type === "bool") set(spec, "true")
      else if (i + 1 < argv.length) set(spec, argv[++i] as string)
      else throw new FlagParseError(`flag needs an argument: --${name}`)
      continue
    }
    if (arg.startsWith("-") && arg.length > 1) {
      let shorthands = arg.slice(1)
      while (shorthands.length > 0) {
        const c = shorthands[0] as string
        const spec = byShort.get(c)
        if (spec === undefined) throw new FlagParseError(`unknown shorthand flag: '${c}' in -${shorthands}`)
        if (shorthands.length > 2 && shorthands[1] === "=") {
          set(spec, shorthands.slice(2))
          shorthands = ""
        } else if (spec.kind.type === "bool") {
          set(spec, "true")
          shorthands = shorthands.slice(1)
        } else if (shorthands.length > 1) {
          set(spec, shorthands.slice(1))
          shorthands = ""
        } else if (i + 1 < argv.length) {
          set(spec, argv[++i] as string)
          shorthands = ""
        } else {
          throw new FlagParseError(`flag needs an argument: '${c}' in -${shorthands}`)
        }
      }
      continue
    }
    args.push(arg)
  }
  return { changed, values, args }
}

/** Typed reads of a parse result. */
export interface FlagReader {
  readonly changed: (long: string) => boolean
  readonly bool: (long: string) => boolean
  readonly string: (long: string, fallback?: string) => string
  readonly slice: (long: string) => ReadonlyArray<string>
  readonly int: (long: string, fallback: number) => number
}

export const flagReader = (parsed: ParsedFlags): FlagReader => ({
  changed: (long) => parsed.changed.has(long),
  bool: (long) => (parsed.values.get(long) as boolean | undefined) ?? false,
  string: (long, fallback = "") => (parsed.values.get(long) as string | undefined) ?? fallback,
  slice: (long) => (parsed.values.get(long) as ReadonlyArray<string> | undefined) ?? [],
  int: (long, fallback) => (parsed.values.get(long) as number | undefined) ?? fallback,
})

/**
 * `gh api`, reproducing GitHub CLI 2.87.3 with stdout not a terminal: the same flags, validation order, request
 * building (fields, placeholders, query strings, GraphQL variables, pagination) and output bytes. The box sends only
 * reads (`readOnlyRefusal`); Kestrel also has no `--template`, `--verbose` or hosts other than github.com.
 */
import type { ApiResponse } from "../github/api"
import { array, bool, FlagParseError, flagReader, parseFlags, slice, str } from "./argv"
import { CommandError, readBodyFile, resolveRepo, SilentExit, type GhRun, type RepoTarget } from "./context"
import { evaluateJq, marshal } from "./json"
import { HELP, USAGE } from "./usage"

const API_FLAGS = [
  str("hostname"),
  str("method", "X"),
  array("field", "F"),
  array("raw-field", "f"),
  array("header", "H"),
  slice("preview", "p"),
  bool("include", "i"),
  bool("slurp"),
  bool("paginate"),
  str("input"),
  bool("silent"),
  str("template", "t"),
  str("jq", "q"),
  str("cache"),
  bool("verbose"),
  bool("help"),
]

/** Go's `%q` for the strings these messages quote. */
const quote = (text: string): string => JSON.stringify(text)

const flagError = (message: string): CommandError => new CommandError(message, USAGE.api ?? null)

/** `time.ParseDuration`'s errors, which pflag reports for `--cache`. */
const durationError = (value: string): string | null => {
  if (/^[-+]?(0|((\d+(\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h))+)$/.test(value)) return null
  const unit = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)([^\d.]+)/.exec(value)?.[1]
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(value)) return `time: missing unit in duration ${quote(value)}`
  if (unit !== undefined) return `time: unknown unit ${quote(unit)} in duration ${quote(value)}`
  return `time: invalid duration ${quote(value)}`
}

/** A request parameter as `parseFields` builds it. Maps have no prototype, so any key is just a key. */
type Param = string | number | boolean | null | ParamMap | Param[]
interface ParamMap {
  [key: string]: Param
}

const newMap = (): ParamMap => Object.create(null) as ParamMap

const isMap = (value: Param | undefined): value is ParamMap => value !== null && typeof value === "object" && !Array.isArray(value)

/** Go's `%T` of a decoded parameter. */
const goType = (value: Param): string => {
  if (value === null) return "<nil>"
  if (Array.isArray(value)) return "[]interface {}"
  if (typeof value === "object") return "map[string]interface {}"
  return typeof value === "number" ? "int" : typeof value
}

const addParamsMap = (m: ParamMap, key: string): ParamMap => {
  if (Object.hasOwn(m, key)) {
    const existing = m[key] as Param
    if (isMap(existing)) return existing
    throw new CommandError(`expected map type under ${quote(key)}, got ${goType(existing)}`)
  }
  const created = newMap()
  m[key] = created
  return created
}

const addParamsSlice = (m: ParamMap, prevKey: string, newKey: string): ParamMap => {
  if (Object.hasOwn(m, prevKey)) {
    const existing = m[prevKey] as Param
    if (!Array.isArray(existing)) throw new CommandError(`expected array type under ${quote(prevKey)}, got ${goType(existing)}`)
    const last = existing[existing.length - 1]
    if (isMap(last) && (!Object.hasOwn(last, newKey) || Array.isArray(last[newKey]))) return last
    const created = newMap()
    existing.push(created)
    return created
  }
  const created = newMap()
  m[prevKey] = [created]
  return created
}

/** `parseFields`' `parseField`: `key[sub][]=value` into `params`; `magic` converts `-F` values. */
const parseField = async (params: ParamMap, field: string, magic: ((value: string) => Promise<Param>) | null): Promise<void> => {
  let valueIndex = 0
  let keyStartAt = 0
  const keystack: string[] = []
  for (let i = 0; i < field.length; i++) {
    const c = field[i]
    if (c === "[") {
      if (keyStartAt === 0) keystack.push(field.slice(0, i))
      keyStartAt = i + 1
    } else if (c === "]") {
      keystack.push(field.slice(keyStartAt, i))
    } else if (c === "=") {
      if (keyStartAt === 0) keystack.push(field.slice(0, i))
      valueIndex = i + 1
      break
    }
  }
  if (keystack.length === 0) throw new CommandError(`invalid key: ${quote(field)}`)

  let key = field
  let value: Param = null
  if (valueIndex === 0) {
    if (keystack[keystack.length - 1] !== "") throw new CommandError(`field ${quote(key)} requires a value separated by an '=' sign`)
  } else {
    key = field.slice(0, valueIndex - 1)
    value = field.slice(valueIndex)
  }
  if (magic !== null && typeof value === "string") {
    try {
      value = await magic(value)
    } catch (error) {
      throw new CommandError(`error parsing ${quote(key)} value: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let dest = params
  let isArray = false
  let subkey = ""
  for (const k of keystack) {
    if (k === "") {
      isArray = true
      continue
    }
    if (subkey !== "") {
      dest = isArray ? addParamsSlice(dest, subkey, k) : addParamsMap(dest, subkey)
      isArray = false
    }
    subkey = k
  }
  if (isArray) {
    if (value === null) {
      dest[subkey] = []
    } else if (Object.hasOwn(dest, subkey)) {
      const existing = dest[subkey] as Param
      if (!Array.isArray(existing)) throw new CommandError(`expected array type under ${quote(subkey)}, got ${goType(existing)}`)
      existing.push(value)
    } else {
      dest[subkey] = [value]
    }
  } else {
    if (Object.hasOwn(dest, subkey)) throw new CommandError(`unexpected override existing field under ${quote(subkey)}`)
    dest[subkey] = value
  }
}

/** Go's `url.QueryEscape`. */
const queryEscape = (text: string): string =>
  encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+")

/** `addQueryParam`: nested maps contribute their own keys, arrays repeat `key[]`. */
const queryPairs = (pairs: Array<[string, string]>, key: string, value: Param): void => {
  if (value === null) pairs.push([key, ""])
  else if (typeof value === "string") pairs.push([key, value])
  else if (typeof value === "number" || typeof value === "boolean") pairs.push([key, String(value)])
  else if (Array.isArray(value)) for (const entry of value) queryPairs(pairs, `${key}[]`, entry)
  else for (const [subkey, entry] of Object.entries(value)) queryPairs(pairs, subkey, entry)
}

/** `addQuery`: `url.Values.Encode`, which sorts by key and keeps each key's values in order. */
const addQuery = (path: string, params: ParamMap): string => {
  if (Object.keys(params).length === 0) return path
  const pairs: Array<[string, string]> = []
  queryPairs(pairs, "", params)
  const encoded = pairs
    .map((pair, index) => ({ pair, index }))
    .sort((x, y) => (x.pair[0] < y.pair[0] ? -1 : x.pair[0] > y.pair[0] ? 1 : x.index - y.index))
    .map(({ pair: [k, v] }) => `${queryEscape(k)}=${queryEscape(v)}`)
    .join("&")
  return `${path}${path.includes("?") ? "&" : "?"}${encoded}`
}

const addPerPage = (path: string, params: ParamMap): string => {
  if (Object.hasOwn(params, "per_page")) return path
  const at = path.indexOf("?")
  if (at >= 0) {
    try {
      if ((new URLSearchParams(path.slice(at + 1)).get("per_page") ?? "") !== "") return path
    } catch {
      // Go's ParseQuery failing still appends per_page.
    }
  }
  return `${path}${at >= 0 ? "&" : "?"}per_page=100`
}

const PLACEHOLDER = /(:(owner|repo|branch)\b|\{[a-z]+\})/g

/** `fillPlaceholders`: `{owner}`, `{repo}` and `{branch}` (or `:owner`...) from the working directory's checkout. */
const placeholders = (run: GhRun) => {
  let repo: Promise<RepoTarget> | null = null
  return async (value: string): Promise<string> => {
    const names = [...value.matchAll(PLACEHOLDER)].map((m) => (m[0].startsWith(":") ? m[0].slice(1) : m[0].slice(1, -1)))
    if (!names.some((name) => name === "owner" || name === "repo" || name === "branch")) return value
    repo ??= resolveRepo(run, "")
    const target = await repo
    return value.replace(PLACEHOLDER, (m) => {
      const name = m.startsWith(":") ? m.slice(1) : m.slice(1, -1)
      if (name === "owner") return target.owner
      if (name === "repo") return target.name
      if (name === "branch") return target.checkout.checkout.branch
      return m
    })
  }
}

/** Go's `http.StatusText`, which an HTTP/2 response's status line carries. */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

/** Go's `textproto.CanonicalMIMEHeaderKey`. */
const canonicalHeader = (name: string): string => name.toLowerCase().replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase())

/** `printHeaders` after `resp.Proto resp.Status`. Go keeps Transfer-Encoding out of `resp.Header`. */
const statusAndHeaders = (response: ApiResponse): string => {
  const lines = response.headers
    .map(([name, value]) => [canonicalHeader(name), value] as const)
    .filter(([name]) => name !== "Status" && name !== "Transfer-Encoding")
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}: ${value}\r\n`)
  return `HTTP/2.0 ${response.status} ${STATUS_TEXT[response.status] ?? ""}\n${lines.join("")}\r\n`
}

const header = (response: ApiResponse, name: string): string => response.headers.find(([n]) => n === name)?.[1] ?? ""

/** A JSON object's field the way Go's decoder finds a struct field: exact name, else case-insensitive. */
const goField = (object: object, name: string): unknown => {
  const entries = Object.entries(object)
  return (entries.find(([k]) => k === name) ?? entries.find(([k]) => k.toLowerCase() === name.toLowerCase()))?.[1]
}

/** `parseErrorResponse`: the error a JSON body reports, or "" when it reports none. */
const serverErrorOf = (body: string, status: number): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error))
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return ""
  const message = goField(parsed, "Message")
  const text = typeof message === "string" ? message : ""
  const errors = goField(parsed, "Errors")
  if (typeof errors === "string" && errors !== "") return text !== "" ? `${errors} (${text})` : errors
  if (text !== "") return `${text} (HTTP ${status})`
  if (!Array.isArray(errors)) return ""
  const messages: string[] = []
  // Go decodes every object into one struct, so an object without a message repeats the previous one.
  let objectMessage = ""
  for (const entry of errors) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const m = goField(entry, "Message")
      if (typeof m === "string") objectMessage = m
      messages.push(objectMessage)
    } else if (typeof entry === "string") {
      messages.push(entry)
    }
  }
  return messages.join("\n")
}

/** `findEndCursor`: the first `pageInfo`'s `endCursor` when its `hasNextPage` is true, else "". */
const findEndCursor = (body: string): string => {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return ""
  }
  let endCursor = ""
  let hasNextPage = false
  let foundEnd = false
  let foundNext = false
  const walk = (value: unknown, key: string): boolean => {
    if (Array.isArray(value)) return value.some((entry) => walk(entry, ""))
    if (value === null || typeof value !== "object") return false
    for (const [k, entry] of Object.entries(value)) {
      if (key === "pageInfo" && k === "endCursor" && typeof entry === "string") {
        endCursor = entry
        foundEnd = true
        if (foundNext) return true
      } else if (key === "pageInfo" && k === "hasNextPage" && typeof entry === "boolean") {
        hasNextPage = entry
        foundNext = true
        if (foundEnd) return true
      } else if (walk(entry, k)) {
        return true
      }
    }
    return false
  }
  walk(data, "")
  return hasNextPage ? endCursor : ""
}

const nextPage = (response: ApiResponse): string | null => {
  for (const m of header(response, "link").matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
    if (m[2] === "next") return m[1] as string
  }
  return null
}

/** `paginatedArrayReader`: consecutive pages of JSON arrays read as one array. */
const joinArrayPage = (body: string, first: boolean, last: boolean): string => {
  let text = body
  if (!first && text.startsWith("[")) text = (text[1] === "]" ? " " : ",") + text.slice(1)
  if (!last && text.endsWith("]")) text = text.slice(0, -1)
  return text
}

export const api = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  let parsed
  try {
    parsed = parseFlags(argv, API_FLAGS)
  } catch (error) {
    if (error instanceof FlagParseError) throw flagError(error.message)
    throw error
  }
  const f = flagReader(parsed)
  if (f.changed("cache")) {
    const invalid = durationError(f.string("cache"))
    if (invalid !== null) throw flagError(`invalid argument ${quote(f.string("cache"))} for "--cache" flag: ${invalid}`)
  }
  if (f.bool("help")) {
    run.stdout += HELP.api ?? ""
    return
  }
  if (parsed.args.length !== 1) throw new CommandError(`accepts 1 arg(s), received ${parsed.args.length}`)

  const endpoint = parsed.args[0] as string
  const flagMethod = f.string("method", "GET")
  const paginate = f.bool("paginate")
  const input = f.string("input")
  const filter = f.string("jq")
  const silent = f.bool("silent")
  if (f.changed("hostname")) {
    const hostname = f.string("hostname")
    if (hostname.trim() === "") throw flagError("error parsing `--hostname`: a value is required")
    if (hostname.includes("/") || hostname.includes(":")) throw flagError("error parsing `--hostname`: invalid hostname")
  }
  if (paginate && flagMethod.toUpperCase() !== "GET" && endpoint !== "graphql") {
    throw flagError("the `--paginate` option is not supported for non-GET requests")
  }
  if (paginate && input !== "") throw flagError("the `--paginate` option is not supported with `--input`")
  if (f.bool("slurp")) {
    if (filter !== "" || f.string("template") !== "") throw flagError("the `--slurp` option is not supported with `--jq` or `--template`")
    if (!paginate) throw flagError("`--paginate` required when passing `--slurp`")
  }
  if ([f.bool("verbose"), silent, filter !== "", f.string("template") !== ""].filter(Boolean).length > 1) {
    throw flagError("only one of `--template`, `--jq`, `--silent`, or `--verbose` may be used")
  }
  if (f.string("template") !== "") throw new CommandError("--template is not available in Kestrel's gh; use --jq to shape JSON output")
  if (f.bool("verbose")) throw new CommandError("--verbose is not available in Kestrel's gh; use --include to see the response status and headers")

  const fill = placeholders(run)
  const params = newMap()
  for (const field of f.slice("raw-field")) await parseField(params, field, null)
  for (const field of f.slice("field")) {
    await parseField(params, field, async (value) => {
      if (value.startsWith("@")) return readBodyFile(run, value.slice(1))
      if (/^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value)
      if (value === "true") return true
      if (value === "false") return false
      if (value === "null") return null
      return fill(value)
    })
  }

  const isGraphQL = endpoint === "graphql"
  let path: string
  try {
    path = await fill(endpoint)
  } catch (error) {
    throw new CommandError(`unable to expand placeholder in path: ${error instanceof Error ? error.message : String(error)}`)
  }
  const hasParams = Object.keys(params).length > 0
  const method = !f.changed("method") && (hasParams || input !== "") ? "POST" : flagMethod
  const headers = [...f.slice("header")]
  let requestBody: ParamMap | string | null = hasParams ? params : null
  if (paginate && !isGraphQL) path = addPerPage(path, params)
  if (input !== "") {
    const content = readBodyFile(run, input)
    path = addQuery(path, params)
    requestBody = content
  }
  const previews = f.slice("preview")
  if (previews.length > 0) {
    headers.push(`Accept: ${[`application/vnd.github.${previews[0]}-preview+json`, ...previews.slice(1).map((p) => `application/vnd.github.${p}-preview`)].join(", ")}`)
  }
  const host = f.string("hostname") || "github.com"
  if (host.toLowerCase() !== "github.com") throw new CommandError(`${host} is not supported: gh in Kestrel works with github.com only`)

  const slurp = paginate && f.bool("slurp")
  const writeBody = (text: string) => {
    if (!silent) run.stdout += text
  }
  let pages = 0
  try {
    let hasNextPage = true
    while (hasNextPage) {
      const response = await run.backend.api(buildRequest(method, path, requestBody, headers))
      if (!isGraphQL) {
        const next = nextPage(response)
        hasNextPage = next !== null
        if (next !== null) path = next
        requestBody = null
      }
      const first = pages === 0
      pages++
      if (slurp) writeBody(first ? "[" : ",")
      const endCursor = await writePage(run, response, {
        method: flagMethod,
        isGraphQL,
        paginate,
        slurp,
        include: f.bool("include"),
        filter,
        first,
        last: !hasNextPage,
        writeBody,
      })
      if (!paginate) break
      if (isGraphQL) {
        hasNextPage = endCursor !== ""
        if (hasNextPage) params.endCursor = endCursor
      }
      if (hasNextPage && f.bool("include")) run.stdout += "\n"
    }
  } finally {
    if (slurp) writeBody(pages === 0 ? "[]" : "]")
  }
}

/** `httpRequest`: GET parameters go in the query string, others in a JSON body (GraphQL variables grouped). */
const buildRequest = (method: string, path: string, params: ParamMap | string | null, flagHeaders: ReadonlyArray<string>) => {
  let target = path
  let body: string | null = null
  let bodyIsJSON = false
  if (typeof params === "string") {
    body = params
  } else if (params !== null) {
    if (method.toUpperCase() === "GET") {
      target = addQuery(target, params)
    } else {
      let payload: ParamMap = params
      if (path === "graphql") {
        payload = newMap()
        const variables = newMap()
        for (const [key, value] of Object.entries(params)) {
          if (key === "query" || key === "operationName") payload[key] = value
          else variables[key] = value
        }
        if (Object.keys(variables).length > 0) payload.variables = variables
      }
      body = marshal(payload)
      bodyIsJSON = true
    }
  }
  const headers: Array<readonly [string, string]> = []
  for (const h of flagHeaders) {
    const at = h.indexOf(":")
    if (at === -1) throw new CommandError(`header ${quote(h)} requires a value separated by ':'`)
    const name = h.slice(0, at)
    const value = h.slice(at + 1).trim()
    if (name.toLowerCase() === "content-length") {
      // Go sets the request's length from it; the box frames the body itself.
      if (!/^[+-]?\d+$/.test(value)) throw new CommandError(`strconv.ParseInt: parsing ${quote(value)}: invalid syntax`)
      continue
    }
    headers.push([name, value])
  }
  const has = (name: string) => headers.some(([n]) => n.toLowerCase() === name)
  if (bodyIsJSON && !has("content-type")) headers.push(["Content-Type", "application/json; charset=utf-8"])
  if (!has("accept")) headers.push(["Accept", "*/*"])
  return { method: method.toUpperCase(), path: target, headers, body }
}

interface PageOptions {
  readonly method: string
  readonly isGraphQL: boolean
  readonly paginate: boolean
  readonly slurp: boolean
  readonly include: boolean
  readonly filter: string
  readonly first: boolean
  readonly last: boolean
  readonly writeBody: (text: string) => void
}

/** `processResponse`: writes one page and resolves to the GraphQL end cursor ("" when there is no next page). */
const writePage = async (run: GhRun, response: ApiResponse, opts: PageOptions): Promise<string> => {
  if (opts.include) run.stdout += statusAndHeaders(response)
  if (response.status === 204) return ""
  const isJSON = /[/+]json(;|$)/.test(header(response, "content-type"))
  let serverError = ""
  if (isJSON && (opts.isGraphQL || response.status >= 400) && opts.method.toUpperCase() !== "HEAD") {
    serverError = serverErrorOf(response.body, response.status)
  }
  const isGraphQLPaginate = isJSON && response.status === 200 && opts.paginate && opts.isGraphQL
  if (opts.filter !== "" && serverError === "") {
    let value: unknown
    try {
      value = JSON.parse(response.body)
    } catch (error) {
      throw new CommandError(error instanceof Error ? error.message : String(error))
    }
    const result = await evaluateJq(value, opts.filter)
    if (!result.ok) throw new CommandError(result.stderr.replace(/\n$/, ""))
    opts.writeBody(result.stdout)
  } else if (isJSON && opts.paginate && !opts.slurp && !isGraphQLPaginate && !opts.include) {
    opts.writeBody(joinArrayPage(response.body, opts.first, opts.last))
  } else {
    opts.writeBody(response.body)
  }
  if (serverError === "" && response.status > 299) serverError = `HTTP ${response.status}`
  if (serverError !== "") {
    run.stderr += `gh: ${serverError}\n`
    throw new SilentExit(1)
  }
  return isGraphQLPaginate ? findEndCursor(response.body) : ""
}

import { Effect } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { BrokerGrant } from "../broker"
import type { Run } from "@cloudagents/protocol"
import { runGh } from "./cli"
import type { GhBackend } from "./context"

export const GH_PREFIX = "/gh/"

/** Requests larger than this (arguments plus `--body-file` contents) are refused. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

export interface GhHandlerDeps {
  readonly grantFor: (token: string) => Effect.Effect<BrokerGrant | null>
  readonly runFor: (runId: string) => Effect.Effect<Run | null>
  /** The shim's backend for one thread. */
  readonly backend: (taskId: string) => GhBackend
}

interface GhRequest {
  readonly cwd: string
  readonly argv: ReadonlyArray<string>
  readonly files: ReadonlyMap<string, string | null>
}

/** Decodes the shim's request body; null when it is malformed. */
export const decodeGhRequest = (body: Uint8Array): GhRequest | null => {
  const decoder = new TextDecoder()
  let offset = 0
  const field = (): string | null => {
    const end = body.indexOf(0, offset)
    if (end === -1) return null
    const text = decoder.decode(body.subarray(offset, end))
    offset = end + 1
    return text
  }
  const count = (): number | null => {
    const text = field()
    return text !== null && /^(0|[1-9]\d{0,6})$/.test(text) ? Number(text) : null
  }
  if (field() !== "kestrel-gh/1") return null
  const cwd = field()
  const argc = count()
  if (cwd === null || argc === null) return null
  const argv: string[] = []
  for (let i = 0; i < argc; i++) {
    const arg = field()
    if (arg === null) return null
    argv.push(arg)
  }
  const fileCount = count()
  if (fileCount === null) return null
  const sizes: Array<[string, number]> = []
  for (let i = 0; i < fileCount; i++) {
    const path = field()
    const size = field()
    if (path === null || size === null || !/^(-1|0|[1-9]\d*)$/.test(size)) return null
    sizes.push([path, Number(size)])
  }
  const files = new Map<string, string | null>()
  for (const [path, size] of sizes) {
    if (size < 0) {
      if (!files.has(path)) files.set(path, null)
      continue
    }
    if (offset + size > body.length) return null
    files.set(path, decoder.decode(body.subarray(offset, offset + size)))
    offset += size
  }
  return offset === body.length ? { cwd, argv, files } : null
}

const readBody = async (req: IncomingMessage): Promise<Uint8Array | null> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) return null
    chunks.push(buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

const plain = (res: ServerResponse, status: number, message: string): void => {
  res.statusCode = status
  res.setHeader("content-type", "text/plain; charset=utf-8")
  res.end(`${message}\n`)
}

/**
 * Answers `POST /gh/<taskId>` from a run's `gh` shim. The bearer token must be the live broker token of a running
 * run of that task, exactly as for MCP.
 */
export const createGhHandler = (deps: GhHandlerDeps) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const match = /^\/gh\/([^/?#]+)$/.exec(req.url ?? "")
  if (match === null) return plain(res, 404, "no such gh route")
  if (req.method !== "POST") {
    res.setHeader("allow", "POST")
    return plain(res, 405, "method not allowed")
  }
  const taskId = decodeURIComponent(match[1] as string)
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1]
  const grant = token === undefined ? null : await Effect.runPromise(deps.grantFor(token))
  const run = grant === null ? null : await Effect.runPromise(deps.runFor(grant.runId))
  if (run === null || run.taskId !== taskId || run.status !== "running") return plain(res, 401, "this run's gh token is not valid")

  const body = await readBody(req)
  if (body === null) return plain(res, 413, "the gh request is too large")
  const request = decodeGhRequest(body)
  if (request === null) return plain(res, 400, "malformed gh request")

  const hangup = new AbortController()
  res.on("close", () => hangup.abort())
  const result = await runGh(
    { backend: deps.backend(taskId), cwd: request.cwd, files: request.files, signal: hangup.signal, stdout: "", stderr: "" },
    request.argv,
  )
  const stderr = Buffer.from(result.stderr, "utf8")
  const stdout = Buffer.from(result.stdout, "utf8")
  res.statusCode = 200
  res.setHeader("content-type", "application/octet-stream")
  res.setHeader("x-gh-exit", String(result.exitCode))
  res.setHeader("x-gh-stderr-bytes", String(stderr.length))
  res.end(Buffer.concat([stderr, stdout]))
}

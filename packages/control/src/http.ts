import { Schema, SchemaAST } from "effect"

/** Error body shape shared with the rest of the API: `{ _tag, message }`. */
export const errorResponse = (status: number, tag: string, message: string): Response =>
  json({ _tag: tag, message }, status)

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const h = new Headers(headers)
  h.set("content-type", "application/json; charset=utf-8")
  h.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { status, headers: h })
}

/**
 * The request's JSON body decoded with `schema`; a 400 response instead when it is not JSON or does not match. Pass
 * `options` to make unknown fields an error.
 */
export const decodeBody = async <A, I>(
  request: Request,
  schema: Schema.Schema<A, I>,
  options?: SchemaAST.ParseOptions,
): Promise<A | Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, "BadRequest", "body must be JSON")
  }
  const decoded = Schema.decodeUnknownEither(schema, options)(body)
  return decoded._tag === "Left" ? errorResponse(400, "BadRequest", "invalid request body") : decoded.right
}

/**
 * `request` when its body is at most `maxBytes`, with the body read into memory; otherwise a 413 response. Reads no more
 * than `maxBytes` plus one chunk, so a route bounds what a client can make it buffer.
 */
export const cappedRequest = async (request: Request, maxBytes: number): Promise<Request | Response> => {
  const tooLarge = (): Response => errorResponse(413, "PayloadTooLarge", `body is larger than ${maxBytes} bytes`)
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return tooLarge()
  if (request.body === null) return request
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return tooLarge()
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body })
}

/** Failure talking to an upstream (GitHub, box) that should surface as 502. */
export class UpstreamError extends Error {}

/** Constant-time string comparison (digests first so length does not leak). */
export const safeEqual = async (a: string, b: string): Promise<boolean> => {
  const enc = new TextEncoder()
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ])
  const x = new Uint8Array(da)
  const y = new Uint8Array(db)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export const readCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

/** Only same-origin absolute paths: must start with a single "/" and no backslash escape. */
export const safeReturnPath = (value: string | null | undefined, fallback: string): string => {
  if (!value) return fallback
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback
  return value
}

/** Masks an API key for display, e.g. `sk-…a1b2`. */
export const maskKey = (key: string): string => `${key.slice(0, 3)}…${key.slice(-4)}`

/** Hop-by-hop and framing headers that must not cross the relay or the response boundary. */
const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  host: true,
  "content-length": true,
}

export const isHopByHop = (name: string): boolean => HOP_BY_HOP[name.toLowerCase()] === true

/** Copies headers into a plain record, dropping hop-by-hop headers and any names in `drop` (lowercase). */
export const headersToRecord = (headers: Headers, drop: Record<string, true> = {}): Record<string, string> => {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (isHopByHop(key) || drop[key] === true) return
    out[key] = value
  })
  return out
}

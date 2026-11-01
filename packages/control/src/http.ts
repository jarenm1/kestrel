import { Schema } from "effect"

/** Error body shape shared with the rest of the API: `{ _tag, message }`. */
export const errorResponse = (status: number, tag: string, message: string): Response =>
  json({ _tag: tag, message }, status)

export const json = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const h = new Headers(headers)
  h.set("content-type", "application/json; charset=utf-8")
  h.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { status, headers: h })
}

/** The request's JSON body decoded with `schema`; a 400 response instead when it is not JSON or does not match. */
export const decodeBody = async <A, I>(request: Request, schema: Schema.Schema<A, I>): Promise<A | Response> => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, "BadRequest", "body must be JSON")
  }
  const decoded = Schema.decodeUnknownEither(schema)(body)
  return decoded._tag === "Left" ? errorResponse(400, "BadRequest", "invalid request body") : decoded.right
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

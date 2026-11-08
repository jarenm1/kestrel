/**
 * Request/stream channel protocol between an app and an agent box.
 *
 * The web app opens a WebRTC data channel to the box (`rtc.ts`) and tunnels `/api/*` HTTP requests
 * and WebSocket streams over it, so the box serves them with its existing local handlers. The
 * channel is authenticated by the box token the offer was posted with, so requests carry no
 * credentials: the box binds the caller's identity to the channel.
 *
 * Text messages carry one JSON `ChannelFrame` each, fragmented per `rtc.ts`. Stream ids are
 * allocated by the caller and are unique per channel; HTTP request ids and WebSocket stream ids
 * share the same id space.
 */

/** Largest response a box sends over the channel, so the reply still fits the message cap. */
export const MAX_CHANNEL_RESPONSE_BYTES = 20 * 1024 * 1024

export type ChannelFrame =
  // app -> box: one HTTP request. `body` is base64, absent when empty.
  | {
      readonly t: "http"
      readonly id: number
      readonly method: string
      readonly path: string // path + query, e.g. "/api/repos?x=1"
      readonly headers: Readonly<Record<string, string>>
      readonly body?: string
    }
  // box -> app: the response to `http` with the same id. `body` is base64.
  | {
      readonly t: "http-res"
      readonly id: number
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly body?: string
    }
  // app -> box: the app opened a stream to `path`.
  | { readonly t: "ws-open"; readonly id: number; readonly path: string; readonly headers: Readonly<Record<string, string>> }
  // either direction: a text message on stream `id`.
  | { readonly t: "ws-text"; readonly id: number; readonly data: string }
  // either direction: stream `id` closed (box: local socket rejected/closed; app: caller left).
  | { readonly t: "ws-close"; readonly id: number; readonly code?: number; readonly reason?: string }
  // either direction, keepalive
  | { readonly t: "ping" }
  | { readonly t: "pong" }

export const encodeFrame = (frame: ChannelFrame): string => JSON.stringify(frame)

/** Parses a text message; returns null for malformed input. */
export const decodeFrame = (text: string): ChannelFrame | null => {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === "object" && v !== null && "t" in v && typeof v.t === "string") return v as ChannelFrame
  } catch {
    // fall through
  }
  return null
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const fromBase64 = (b64: string): Uint8Array => {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

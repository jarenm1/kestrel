import { Schema } from "effect"
import type { DesktopClose } from "@/desktop/session"

/** Tags every message to and from the host, so unrelated `postMessage` traffic is ignored. */
export const HOST_TYPE = "kestrel-desktop"

const HostMessage = Schema.Struct({ type: Schema.Literal(HOST_TYPE), ws: Schema.String })
const decodeHostMessage = Schema.decodeUnknownOption(Schema.Union(HostMessage, Schema.parseJson(HostMessage)))

/** The WebSocket URL a host message names, or null when the message is not for this viewer. */
export function hostWs(data: unknown): string | null {
  const decoded = decodeHostMessage(data)
  return decoded._tag === "Some" ? decoded.value.ws : null
}

/** The `ws` fragment value, decoded once by URLSearchParams. `hash` is `location.hash`, with or without `#`. */
export function fragmentWs(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("ws")
}

/** 4401 is the app's unauthorized close; 401 covers a proxy that closes with the HTTP status. A socket that never opened is treated the same. */
export function isAuthClose(close: DesktopClose): boolean {
  return close.code === 4401 || close.code === 401 || !close.opened
}

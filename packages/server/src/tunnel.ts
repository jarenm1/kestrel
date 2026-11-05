import {
  BOX_USER_HEADER,
  CREDENTIALS_HEADER,
  MAX_RELAY_RESPONSE_BYTES,
  fromBase64,
  toBase64,
  type RelayFrame,
} from "@cloudagents/protocol"

/**
 * Set to "1" on a tunnelled request from a `/auth/dev-login` session (dev-only flows such as fixture replay).
 * Like BOX_USER_HEADER, only the tunnel sets it: the browser's copy is dropped and main.ts strips it locally.
 */
export const BOX_DEV_HEADER = "x-kestrel-box-dev"

/** Placeholder origin for building Request URLs from tunnelled paths. */
export const TUNNEL_ORIGIN = "http://box.local"

/** Who a tunnelled request acts for. Null means no signed-in user. */
export interface TunnelIdentity {
  readonly user: string
  readonly dev: boolean
}

/** Headers that describe the tunnel hop or carry identity, so a tunnelled request does not forward them. */
const HOP_HEADERS: Record<string, true> = {
  host: true,
  "content-length": true,
  connection: true,
  "transfer-encoding": true,
  upgrade: true,
  [CREDENTIALS_HEADER]: true,
  [BOX_USER_HEADER]: true,
  [BOX_DEV_HEADER]: true,
  "x-kestrel-preview-token": true,
}

/**
 * Serves one tunnelled HTTP request with the box's local handler and replies with an `http-res` frame carrying the
 * same id. The identity is the only user the handler sees: headers from the tunnel never set it.
 */
export const serveTunnelHttp = async (
  frame: Extract<RelayFrame, { t: "http" }>,
  handle: (req: Request) => Promise<Response>,
  identity: TunnelIdentity | null,
  reply: (frame: RelayFrame) => void,
): Promise<void> => {
  let res: Response
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(frame.headers)) {
      if (HOP_HEADERS[name.toLowerCase()] !== true) headers.set(name, value)
    }
    if (identity !== null) headers.set(BOX_USER_HEADER, identity.user)
    if (identity?.dev === true) headers.set(BOX_DEV_HEADER, "1")
    const body = frame.body === undefined ? undefined : new Uint8Array(fromBase64(frame.body))
    const req = new Request(new URL(frame.path, TUNNEL_ORIGIN), { method: frame.method, headers, body })
    res = await handle(req)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res = Response.json({ error: "InternalError", message }, { status: 500 })
  }
  // One frame carries the whole body, and Cloudflare refuses messages over 32 MiB: a larger response would never
  // arrive. Say so instead; a declared length spares reading a large file just to refuse it.
  const tooLarge = () =>
    Response.json(
      { _tag: "PayloadTooLarge", message: `responses over ${MAX_RELAY_RESPONSE_BYTES} bytes cannot go through the relay` },
      { status: 413 },
    )
  if (Number(res.headers.get("content-length") ?? 0) > MAX_RELAY_RESPONSE_BYTES) {
    await res.body?.cancel()
    res = tooLarge()
  }
  let bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > MAX_RELAY_RESPONSE_BYTES) {
    res = tooLarge()
    bytes = new Uint8Array(await res.arrayBuffer())
  }
  const headers: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    headers[name] = value
  })
  reply({
    t: "http-res",
    id: frame.id,
    status: res.status,
    headers,
    body: bytes.byteLength > 0 ? toBase64(bytes) : undefined,
  })
}

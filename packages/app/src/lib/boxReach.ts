import { BoxUrl } from "@cloudagents/protocol"
import { Either, Schema } from "effect"

/** How long a reachability check waits for the box's health before it counts as unreachable. */
export const REACH_TIMEOUT_MS = 8_000

export const BOX_URL_ERROR =
  "Nothing was checked: the URL must be an origin such as https://box.example.com (http is allowed only for localhost)."

/** Where a box URL points: this device's own loopback, a Tailscale name, or any other HTTPS address. */
export type BoxUrlKind = "local" | "tailnet" | "https"

/** The box URL the server would accept (trailing slashes dropped), or null: checked before any request is made. */
export function parseBoxUrl(url: string): string | null {
  const result = Schema.decodeUnknownEither(BoxUrl)(url.trim().replace(/\/+$/, ""))
  return Either.isRight(result) ? result.right : null
}

export function boxUrlKind(url: string): BoxUrlKind {
  const host = new URL(url).hostname
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return "local"
  return host.endsWith(".ts.net") ? "tailnet" : "https"
}

/** Whether this device gets the box's health within `timeoutMs`; a check that never settles counts as unreachable. */
export function checkReach(
  url: string,
  check: (url: string) => Promise<{ readonly online: boolean }>,
  timeoutMs = REACH_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([check(url).then((status) => status.online, () => false), expired]).finally(() =>
    clearTimeout(timer),
  )
}

/** What a reachability result means, said from this device only: it is not the box's health for everyone. */
export function reachText(kind: BoxUrlKind, reachable: boolean): string {
  if (reachable) {
    const scope =
      kind === "local"
        ? "localhost is the machine this browser runs on, so other devices need an HTTPS address for this box."
        : "Other devices reach it only if their network can."
    return `This device reached the box's API. ${scope} The live desktop uses WebRTC, a separate connection this does not test.`
  }
  const hint =
    kind === "local"
      ? "localhost is the machine this browser runs on: start the box here, or use the HTTPS address of the machine it runs on."
      : kind === "tailnet"
        ? "Check that this device is signed in to the same tailnet as the box, that Tailscale Serve is running on the box's machine, and allow local network access if the browser asks."
        : "Check that the box is running and that its tunnel or proxy forwards to it. Plain http:// to another machine, even on the same Wi-Fi, cannot be reached from the app."
  return `This device could not reach the box's API. ${hint} This check is only from here and does not stop you from adding the box.`
}

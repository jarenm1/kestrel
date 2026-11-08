import { BoxUrl } from "@cloudagents/protocol"
import { Schema } from "effect"
import type { Check } from "./doctor"
import { printChecks } from "./doctor"
import type { Exec } from "./system"
import { CliError, exec, isWsl, onPath } from "./system"

/** Injectable process access so detection stays pure and testable. */
export interface ExecDeps {
  readonly onPath: (name: string) => string | null
  readonly run: (cmd: string, args: readonly string[]) => Exec
}

const defaultDeps: ExecDeps = { onPath, run: exec }

/** Read-only view of the Tailscale on this machine (or guest: the CLI runs where the box runs). */
export interface Tailscale {
  readonly installed: boolean
  /** `tailscale status` reports BackendState "Running". */
  readonly running: boolean
  /** This node's tailnet name, e.g. "box.tail-abc.ts.net"; null unless running. */
  readonly dnsName: string | null
  /** Proxy targets Tailscale Serve publishes on tailnet port 443. */
  readonly serveTargets: readonly string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/** Proxy targets `tailscale serve status --json` binds to tailnet port 443. */
const parseServeTargets = (stdout: string): string[] => {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!isRecord(json)) return []
  const targets: string[] = []
  const collect = (handlers: unknown): void => {
    if (!isRecord(handlers)) return
    for (const handler of Object.values(handlers)) {
      const proxy = isRecord(handler) ? handler.Proxy : undefined
      if (typeof proxy === "string") targets.push(proxy)
    }
  }
  if (isRecord(json.TCP) && isRecord(json.TCP["443"])) collect(json.TCP["443"].Handlers)
  if (isRecord(json.Web)) {
    for (const [key, site] of Object.entries(json.Web)) {
      if (key.endsWith(":443") && isRecord(site)) collect(site.Handlers)
    }
  }
  return targets
}

/** Probes tailscale and its Serve config without changing either. */
export const detectTailscale = (deps: ExecDeps = defaultDeps): Tailscale => {
  const bin = deps.onPath("tailscale")
  const off: Tailscale = { installed: false, running: false, dnsName: null, serveTargets: [] }
  if (bin === null) return off

  const status = deps.run(bin, ["status", "--json"])
  if (status.status !== 0) return { ...off, installed: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    return { ...off, installed: true }
  }
  const running = isRecord(parsed) && parsed.BackendState === "Running"
  const self = isRecord(parsed) && isRecord(parsed.Self) ? parsed.Self : {}
  const dns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null
  const dnsName = running && dns !== null && dns !== "" ? dns : null
  if (dnsName === null) return { ...off, installed: true, running }

  const serve = deps.run(bin, ["serve", "status", "--json"])
  return {
    installed: true,
    running: true,
    dnsName,
    serveTargets: serve.status === 0 ? parseServeTargets(serve.stdout) : [],
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

/** True when a Serve proxy target points at the box's own API port on loopback. */
export const proxiesLocalPort = (target: string, port: number): boolean => {
  const normalized = target.startsWith("https+insecure://")
    ? `https://${target.slice("https+insecure://".length)}`
    : target
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return false
  }
  const targetPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port)
  return LOOPBACK.has(url.hostname) && targetPort === port
}

/** A box URL Tailscale Serve demonstrably proxies to this port; null otherwise. DNSName alone is never enough. */
export const suggestedUrl = (ts: Tailscale, port: number): string | null => {
  if (ts.dnsName === null || !ts.serveTargets.some((target) => proxiesLocalPort(target, port))) return null
  const url = `https://${ts.dnsName}`
  return Schema.is(BoxUrl)(url) ? url : null
}

export type UrlSource = "explicit" | "tailscale-serve" | "localhost"

/** The URL `login` offers for pairing: an explicit `--url` always wins over detection. */
export const resolveBoxUrl = (
  explicit: string | undefined,
  port: number,
  deps: ExecDeps = defaultDeps,
): { readonly url: string; readonly source: UrlSource } => {
  if (explicit !== undefined) return { url: explicit, source: "explicit" }
  const suggested = suggestedUrl(detectTailscale(deps), port)
  if (suggested !== null) return { url: suggested, source: "tailscale-serve" }
  return { url: `http://localhost:${port}`, source: "localhost" }
}

/** Optional doctor checks describing how the box can be reached. */
export const networkChecks = (port: number, ts: Tailscale): Check[] => {
  const suggested = suggestedUrl(ts, port)
  const serveDetail = !ts.running
    ? `skipped (tailscale not connected)`
    : ts.serveTargets.some((target) => proxiesLocalPort(target, port))
      ? `443 -> this box's port ${port}`
      : ts.serveTargets.length > 0
        ? `443 -> ${ts.serveTargets.join(", ")} (not this box's port ${port})`
        : `not configured; run \`kestrel-box network --serve\` or: tailscale serve --bg --https=443 http://127.0.0.1:${port}`
  return [
    {
      name: "tailscale CLI",
      required: false,
      ok: ts.installed,
      detail: ts.installed ? "found" : "not installed (optional; https://tailscale.com/download)",
    },
    {
      name: "tailscale connected",
      required: false,
      ok: ts.running,
      detail: ts.running
        ? `as ${ts.dnsName}`
        : ts.installed
          ? "not logged in; run `tailscale up` yourself if you want a tailnet URL"
          : "skipped (no tailscale CLI)",
    },
    { name: "tailscale serve -> box", required: false, ok: suggested !== null, detail: serveDetail },
    {
      name: "box URL",
      required: false,
      ok: true,
      detail: `${suggested ?? `http://localhost:${port}`} (change with \`kestrel-box login --url <origin> --force\` or Settings > Boxes)`,
    },
  ]
}

/**
 * Opt-in: publish the box's port on tailnet 443. Refuses to touch an existing 443 Serve config, never logs tailscale
 * in, never installs it, and never enables Funnel.
 */
export const enableTailscaleServe = (ts: Tailscale, port: number, deps: ExecDeps = defaultDeps): Tailscale => {
  const bin = deps.onPath("tailscale")
  if (bin === null || !ts.installed) {
    throw new CliError("tailscale is not installed; install it from https://tailscale.com/download, sign in, then re-run `kestrel-box network --serve`")
  }
  if (!ts.running || ts.dnsName === null) {
    throw new CliError("tailscale is installed but not logged in; run `tailscale up` (or sign in from its app) first")
  }
  const conflicts = ts.serveTargets.filter((target) => !proxiesLocalPort(target, port))
  if (conflicts.length > 0) {
    throw new CliError(
      `Tailscale Serve already publishes 443 -> ${conflicts.join(", ")}; not overwriting it. Run \`tailscale serve reset\` yourself if that was stale, then retry.`,
    )
  }
  if (ts.serveTargets.length > 0) {
    console.log(`Tailscale Serve already publishes 443 -> this box's port ${port}.`)
    return ts
  }
  const run = deps.run(bin, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`])
  if (run.status !== 0) {
    throw new CliError(`\`tailscale serve\` failed: ${run.stderr.trim() || run.stdout.trim() || `exit ${run.status ?? "?"}`} (it may need sudo, or a Tailscale operator set)`)
  }
  console.log(`Tailscale Serve publishes https://${ts.dnsName} -> http://127.0.0.1:${port} on your tailnet.`)
  return detectTailscale(deps)
}

/** `kestrel-box network`: how this box can be reached, and the commands to change that. */
export const network = (port: number, options: { readonly serve: boolean }, deps: ExecDeps = defaultDeps): void => {
  let ts = detectTailscale(deps)
  if (options.serve) ts = enableTailscaleServe(ts, port, deps)
  printChecks(networkChecks(port, ts))
  const suggested = suggestedUrl(ts, port)
  console.log("")
  console.log(`Reachable at: ${suggested ?? `http://localhost:${port}`}`)
  if (suggested === null) {
    console.log("To use this box from other devices it must answer HTTPS at a public origin:")
    console.log("  - Tailscale Serve (tailnet only): kestrel-box network --serve")
    console.log(`  - your own reverse proxy or a Cloudflare Tunnel pointing at 127.0.0.1:${port}`)
    console.log("Then pair or update the URL: kestrel-box login --url <origin> --force (or Settings > Boxes)")
    console.log("Point the tunnel at the box port directly: the agent-only paths (/mcp, /broker, /gh/) live on a separate loopback listener it cannot reach.")
  }
  if (isWsl()) {
    console.log(
      "This is WSL: Tailscale inside the distro and Tailscale on Windows are separate machines on the tailnet. " +
        "Windows localhost forwarding also reaches the box, so `tailscale serve` run on Windows pointing at " +
        `http://localhost:${port} works without installing Tailscale here.`,
    )
  }
}

import { useState, type MouseEvent } from "react"
import type {
  ActivityDay,
  CliProvider,
  ProviderBankedReset,
  ProviderUsage,
  ProviderUsageWindow,
  UseBankedResetResult,
} from "@cloudagents/protocol"
import { Alert } from "../alert"
import { Button } from "../button"
import { cn } from "../cn"
import { ActivityHeatmap } from "./ActivityHeatmap"

/** The box answers from a cache of the same length, so a faster poll would not show anything newer. */
export const USAGE_REFRESH_MS = 60_000
const MINUTE_MS = 60_000
/** The connections page has the same URL in the desktop app and on phone web. */
const CONNECTIONS_PATH = "/settings/connections"

const PROVIDER_LABELS: Record<CliProvider, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
  "antigravity-cli": "Antigravity",
  "opencode-go": "OpenCode Go",
}

/** A banked reset the user asked to spend, and how that request is going. */
export type ResetAction = { readonly provider: CliProvider; readonly resetId: string } & (
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "done"; readonly outcome: UseBankedResetResult["outcome"] }
)

/** The fields of a `useBankedReset` mutation the panel reads; TanStack Query's mutation result has this shape. */
export interface ResetMutation {
  readonly variables: { readonly provider: CliProvider; readonly resetId: string } | undefined
  readonly status: "idle" | "pending" | "error" | "success"
  readonly error: unknown
  readonly data: UseBankedResetResult | undefined
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The mutation's latest request as plain data, so it can cross the Expo DOM bridge. */
export function resetActionOf(mutation: ResetMutation): ResetAction | null {
  const target = mutation.variables
  if (target === undefined) return null
  switch (mutation.status) {
    case "idle":
      return null
    case "pending":
      return { ...target, status: "pending" }
    case "error":
      return { ...target, status: "failed", error: errorText(mutation.error) }
    case "success":
      return mutation.data ? { ...target, status: "done", outcome: mutation.data.outcome } : null
  }
}

/** `On <box> · 2 providers`, the line under the panel's title; either part is left out while it loads. */
export function usageSubtitle(box: string | null, providers: number | null): string {
  const count = providers === null ? null : `${providers} ${providers === 1 ? "provider" : "providers"}`
  return [box === null ? null : `On ${box}`, count].filter((part) => part !== null).join(" · ")
}

/**
 * Column widths shared by every provider's rows, so the bars line up down the table. Below `sm` the provider sits above
 * its limits, and each limit puts its bar on a full-width second line.
 */
const ROW = "grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)]"
const WINDOW_ROW =
  "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[8rem_minmax(0,1fr)_5rem_8rem] sm:gap-x-5"

/** `4h56m`, `2d18h`: the two largest units left until `at`; null once it has passed. */
function timeLeft(at: string, now: number): string | null {
  const minutes = Math.ceil((Date.parse(at) - now) / MINUTE_MS)
  if (minutes <= 0) return null
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d${hours}h`
  return `${hours > 0 ? `${hours}h` : ""}${minutes % 60}m`
}

function resetsText(resetsAt: string, now: number): string {
  const left = timeLeft(resetsAt, now)
  return left === null ? "resets soon" : `resets in ${left}`
}

const expiryFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function expiresText(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return "Never expires"
  const left = timeLeft(expiresAt, now)
  return `${left === null ? "Expires soon" : `Expires in ${left}`} · ${expiryFormat.format(new Date(expiresAt))}`
}

const OUTCOME_TEXT: Record<UseBankedResetResult["outcome"], string> = {
  reset: "Reset used: the limits it covers are full again.",
  nothing_to_reset: "Nothing to reset yet: your limits aren’t used enough. The reset was kept.",
  no_reset: "That reset is no longer available; it was used or expired.",
}

/** The banked resets of one provider; each can be spent on its own. */
function BankedResetList({
  provider,
  available,
  resets,
  now,
  action,
  onUseReset,
}: {
  provider: CliProvider
  available: number
  resets: readonly ProviderBankedReset[]
  now: number
  action: ResetAction | null
  onUseReset: (provider: CliProvider, resetId: string) => void
}) {
  const pending = action?.status === "pending"
  const own = action?.provider === provider ? action : null
  const unlisted = available - resets.length
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
        {resets.map((reset) => (
          <li key={reset.id} className="flex items-center justify-between gap-4 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="truncate">{reset.title ?? "Banked reset"}</span>
              <span className="text-muted-foreground tabular-nums">{expiresText(reset.expiresAt, now)}</span>
            </div>
            <Button size="sm" variant="soft" disabled={pending} onClick={() => onUseReset(provider, reset.id)}>
              {pending && own?.resetId === reset.id ? "Using…" : "Use reset"}
            </Button>
          </li>
        ))}
        {unlisted > 0 && (
          <li className="px-3 py-2 text-muted-foreground">
            {unlisted} more {unlisted === 1 ? "reset" : "resets"} {PROVIDER_LABELS[provider]} didn’t list.
          </li>
        )}
      </ul>
      {own?.status === "failed" && <Alert>{own.error}</Alert>}
      {own?.status === "done" && <span className="text-muted-foreground">{OUTCOME_TEXT[own.outcome]}</span>}
    </div>
  )
}

function WindowRow({ window, now }: { window: ProviderUsageWindow; now: number }) {
  const used = Math.round(window.usedPercent)
  return (
    <div className={WINDOW_ROW}>
      <span className="truncate text-muted-foreground">{window.label}</span>
      <div
        role="progressbar"
        aria-label={`${window.label} limit used`}
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={100}
        className="col-span-3 row-start-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06] sm:col-span-1 sm:row-start-auto"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            used >= 90 ? "bg-destructive" : used >= 75 ? "bg-warning" : "bg-muted-foreground",
          )}
          style={{ width: `${window.usedPercent}%` }}
        />
      </div>
      <span className="text-right whitespace-nowrap">
        <span className="font-semibold tabular-nums">{100 - used}%</span>
        <span className="text-muted-foreground"> left</span>
      </span>
      <span className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
        {window.resetsAt !== null && resetsText(window.resetsAt, now)}
      </span>
    </div>
  )
}

function ProviderRow({
  usage,
  now,
  action,
  onUseReset,
}: {
  usage: ProviderUsage
  now: number
  action: ResetAction | null
  onUseReset: (provider: CliProvider, resetId: string) => void
}) {
  const [showResets, setShowResets] = useState(false)
  const banked = usage.bankedResets?.available ?? 0
  return (
    <section className={cn(ROW, "border-t border-border/60 py-3 first:border-t-0")}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate font-medium">{PROVIDER_LABELS[usage.provider]}</h3>
          {usage.plan !== null && <span className="text-muted-foreground capitalize">{usage.plan}</span>}
          {banked > 0 && (
            <button
              type="button"
              aria-expanded={showResets}
              onClick={() => setShowResets((shown) => !shown)}
              className="w-fit text-left text-success underline-offset-2 hover:underline"
            >
              {banked} banked {banked === 1 ? "reset" : "resets"}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {usage.windows.length === 0 ? (
          <span className="text-muted-foreground">This plan reports no limits.</span>
        ) : (
          usage.windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)
        )}
      </div>
      {showResets && banked > 0 && usage.bankedResets && (
        <BankedResetList
          provider={usage.provider}
          available={banked}
          resets={usage.bankedResets.resets}
          now={now}
          action={action}
          onUseReset={onUseReset}
        />
      )}
    </section>
  )
}

/** Providers with nothing to chart, one line per state, so they cost a line rather than a section each. */
function OtherProviders({ usage, onOpenConnections }: { usage: readonly ProviderUsage[]; onOpenConnections: () => void }) {
  const signedOut = usage.filter((u) => u.status === "signed_out")
  const unavailable = usage.filter((u) => u.status === "unavailable")
  if (signedOut.length === 0 && unavailable.length === 0) return null
  // A real link, so the desktop can open it in a new tab; a plain click goes through the host's own navigation.
  const openConnections = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    onOpenConnections()
  }
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      {signedOut.length > 0 && (
        <div className={ROW}>
          <span className="pl-4 text-muted-foreground">Not signed in</span>
          <span>
            {signedOut.map((u) => PROVIDER_LABELS[u.provider]).join(", ")}
            {" · "}
            <a
              href={CONNECTIONS_PATH}
              onClick={openConnections}
              className="text-muted-foreground underline underline-offset-2"
            >
              Connections
            </a>
          </span>
        </div>
      )}
      {unavailable.map((u) => (
        <div key={u.provider} className={ROW}>
          <span className="pl-4 text-muted-foreground">Couldn’t read limits</span>
          <span className="min-w-0">
            {PROVIDER_LABELS[u.provider]}
            <span className="text-muted-foreground">: {u.error ?? "the CLI did not answer"}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Every data value is plain JSON and every callback returns nothing, so the same props work in the desktop dialog, on
 * phone web, and across Expo's DOM bridge into a native WebView.
 */
export interface UsageQuotasProps {
  /** The providers' limits; undefined until the first answer. */
  readonly usage: readonly ProviderUsage[] | undefined
  readonly usageError: string | null
  /** When `usage` was read (epoch ms); countdowns are relative to it, as the box's numbers are. */
  readonly updatedAt: number
  /** Runs per local day; undefined while loading. */
  readonly activity: readonly ActivityDay[] | undefined
  readonly activityError: string | null
  readonly resetAction: ResetAction | null
  readonly onUseReset: (provider: CliProvider, resetId: string) => void
  readonly onOpenConnections: () => void
}

/** The providers' limits and banked resets, then the year of activity. The host draws the title. */
export function UsageQuotas({
  usage,
  usageError,
  updatedAt,
  activity,
  activityError,
  resetAction,
  onUseReset,
  onOpenConnections,
}: UsageQuotasProps) {
  const charted = usage?.filter((u) => u.status === "ok") ?? []
  return (
    // The same column and gap as the desktop dialog, so the panel lays out alike in hosts without one.
    <div className="flex flex-col gap-4">
      {usageError !== null && <Alert>{usageError}</Alert>}
      {usage === undefined && usageError === null && <div className="text-muted-foreground">Asking the providers…</div>}
      {usage && (
        <div className="flex flex-col">
          {charted.map((provider) => (
            <ProviderRow
              key={provider.provider}
              usage={provider}
              now={updatedAt}
              action={resetAction}
              onUseReset={onUseReset}
            />
          ))}
          <OtherProviders usage={usage} onOpenConnections={onOpenConnections} />
        </div>
      )}
      {activityError !== null ? (
        <Alert>{activityError}</Alert>
      ) : (
        <div className="mt-2">
          <ActivityHeatmap days={activity} today={new Date()} />
        </div>
      )}
    </div>
  )
}

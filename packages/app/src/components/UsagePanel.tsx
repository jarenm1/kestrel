import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type {
  CliProvider,
  ProviderBankedReset,
  ProviderUsage,
  ProviderUsageWindow,
  UseBankedResetResult,
} from "@cloudagents/protocol"
import { Link } from "react-router-dom"
import { api } from "@/api/client"
import { keys, queries, queryClient } from "@/api/queries"
import { boxName } from "@/components/BoxPicker"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ActivityHeatmap } from "@/components/ActivityHeatmap"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** The box answers from a cache of the same length, so a faster poll would not show anything newer. */
const REFRESH_MS = 60_000
const MINUTE_MS = 60_000

const PROVIDER_LABELS: Record<CliProvider, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
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
}: {
  provider: CliProvider
  available: number
  resets: readonly ProviderBankedReset[]
  now: number
}) {
  const use = useMutation({
    mutationFn: (resetId: string) => api.useBankedReset(provider, { resetId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.providerUsage }),
  })
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
            <Button size="sm" variant="soft" disabled={use.isPending} onClick={() => use.mutate(reset.id)}>
              {use.isPending && use.variables === reset.id ? "Using…" : "Use reset"}
            </Button>
          </li>
        ))}
        {unlisted > 0 && (
          <li className="px-3 py-2 text-muted-foreground">
            {unlisted} more {unlisted === 1 ? "reset" : "resets"} {PROVIDER_LABELS[provider]} didn’t list.
          </li>
        )}
      </ul>
      {use.error && <Alert>{errorText(use.error)}</Alert>}
      {use.data && <span className="text-muted-foreground">{OUTCOME_TEXT[use.data.outcome]}</span>}
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

function ProviderRow({ usage, now }: { usage: ProviderUsage; now: number }) {
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
        />
      )}
    </section>
  )
}

/** Providers with nothing to chart, one line per state, so they cost a line rather than a section each. */
function OtherProviders({ usage, onClose }: { usage: readonly ProviderUsage[]; onClose: () => void }) {
  const signedOut = usage.filter((u) => u.status === "signed_out")
  const unavailable = usage.filter((u) => u.status === "unavailable")
  if (signedOut.length === 0 && unavailable.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      {signedOut.length > 0 && (
        <div className={ROW}>
          <span className="pl-4 text-muted-foreground">Not signed in</span>
          <span>
            {signedOut.map((u) => PROVIDER_LABELS[u.provider]).join(", ")}
            {" · "}
            <Link to="/settings/connections" onClick={onClose} className="text-muted-foreground underline underline-offset-2">
              Connections
            </Link>
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

const OpenUsagePanel = createContext<() => void>(() => {})

/** Opens the usage panel from anywhere in the workspace. */
export const useOpenUsagePanel = () => useContext(OpenUsagePanel)

/** Holds the usage panel for every signed-in page, so opening it never navigates away from a thread or its draft. */
export function UsagePanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // The dialog has no trigger to give focus back to, and `/usage` should leave the caret in the composer.
  const returnFocus = useRef<HTMLElement | null>(null)
  const show = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpen(true)
  }, [])

  return (
    <OpenUsagePanel.Provider value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-4xl"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocus.current?.focus()
          }}
        >
          <UsagePanelBody onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </OpenUsagePanel.Provider>
  )
}

function UsagePanelBody({ onClose }: { onClose: () => void }) {
  const usage = useQuery({ ...queries.providerUsage(), refetchInterval: REFRESH_MS })
  const activity = useQuery({ ...queries.usageActivity(), refetchInterval: REFRESH_MS })
  const boxes = useQuery(queries.boxes())
  const charted = usage.data?.filter((u) => u.status === "ok") ?? []

  return (
    <>
      <div className="flex items-baseline justify-between gap-4 pr-8">
        <DialogTitle>Quotas</DialogTitle>
        <DialogDescription>
          {boxes.data && `On ${boxName(boxes.data.activeBoxId, boxes.data)}`}
          {boxes.data && usage.data && " · "}
          {usage.data && `${usage.data.length} ${usage.data.length === 1 ? "provider" : "providers"}`}
        </DialogDescription>
      </div>
      {usage.error && <Alert>{errorText(usage.error)}</Alert>}
      {usage.isPending && <div className="text-muted-foreground">Asking the providers…</div>}
      {usage.data && (
        <div className="flex flex-col">
          {charted.map((provider) => (
            <ProviderRow key={provider.provider} usage={provider} now={usage.dataUpdatedAt} />
          ))}
          <OtherProviders usage={usage.data} onClose={onClose} />
        </div>
      )}
      {activity.error ? (
        <Alert>{errorText(activity.error)}</Alert>
      ) : (
        <div className="mt-2">
          <ActivityHeatmap days={activity.data?.days} today={new Date()} />
        </div>
      )}
    </>
  )
}

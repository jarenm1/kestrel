import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import type { CliProvider, ProviderUsage, ProviderUsageWindow } from "@cloudagents/protocol"
import { Link } from "react-router-dom"
import { queries } from "@/api/queries"
import { boxName } from "@/components/BoxPicker"
import { Alert } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** The box answers from a cache of the same length, so a faster poll would not show anything newer. */
const REFRESH_MS = 60_000
const HOUR_MS = 3_600_000

const PROVIDER_LABELS: Record<CliProvider, string> = {
  "claude-cli": "Claude Code",
  "codex-cli": "Codex",
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function resetsText(resetsAt: string, now: number): string {
  const left = Date.parse(resetsAt) - now
  if (left <= 0) return "Resets soon"
  if (left >= 24 * HOUR_MS) return `Resets ${dateFormat.format(new Date(resetsAt))}`
  const totalMinutes = Math.ceil(left / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  return `Resets in ${hours > 0 ? `${hours}h ` : ""}${totalMinutes % 60}m`
}

function LimitBar({ window, now }: { window: ProviderUsageWindow; now: number }) {
  const percent = Math.round(window.usedPercent)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span>{window.label}</span>
        <span className="font-medium tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${window.label} limit used`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${window.usedPercent}%` }}
        />
      </div>
      {window.resetsAt !== null && <span className="text-xs text-muted-foreground">{resetsText(window.resetsAt, now)}</span>}
    </div>
  )
}

function ProviderSection({ usage, onClose, now }: { usage: ProviderUsage; onClose: () => void; now: number }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-white/[0.03] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium">{PROVIDER_LABELS[usage.provider]}</h3>
        {usage.plan !== null && <span className="text-xs text-muted-foreground capitalize">{usage.plan}</span>}
      </div>
      {usage.status === "signed_out" && (
        <p className="text-muted-foreground">
          No subscription signed in on this box.{" "}
          <Link to="/settings/connections" onClick={onClose} className="text-foreground underline underline-offset-2">
            Connections
          </Link>
        </p>
      )}
      {usage.status === "unavailable" && (
        <p className="text-muted-foreground">Couldn’t read its limits: {usage.error ?? "the CLI did not answer"}.</p>
      )}
      {usage.status === "ok" && usage.windows.length === 0 && (
        <p className="text-muted-foreground">This plan reports no limits.</p>
      )}
      {usage.windows.map((window) => (
        <LimitBar key={window.id} window={window} now={now} />
      ))}
    </section>
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
  const boxes = useQuery(queries.boxes())

  return (
    <>
      <DialogTitle>Usage</DialogTitle>
      <DialogDescription>
        Subscription limits{boxes.data && ` on ${boxName(boxes.data.activeBoxId, boxes.data)}`}
      </DialogDescription>
      {usage.error && <Alert>{errorText(usage.error)}</Alert>}
      {usage.isPending && <div className="text-muted-foreground">Asking the providers…</div>}
      {usage.data?.map((provider) => (
        <ProviderSection key={provider.provider} usage={provider} onClose={onClose} now={usage.dataUpdatedAt} />
      ))}
    </>
  )
}

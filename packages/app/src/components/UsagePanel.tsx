import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { CURRENT_PLAN, PLANS, type Plan, type Usage } from "@cloudagents/protocol"
import { Link } from "react-router-dom"
import { queries } from "@/api/queries"
import { boxName } from "@/components/BoxPicker"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

/** A running turn counts up to now, so the open panel keeps refreshing. */
const REFRESH_MS = 30_000

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

function hours(seconds: number): string {
  const h = seconds / 3600
  if (h > 0 && h < 0.1) return "<0.1"
  return h < 10 ? h.toFixed(1) : Math.round(h).toString()
}

export function UsageSummary({ usage, plan }: { usage: Usage; plan: Plan }) {
  const usedHours = usage.agentSeconds / 3600
  const share = plan.agentHours === null ? 0 : Math.min(1, usedHours / plan.agentHours)
  const lastDay = new Date(Date.parse(usage.periodEnd) - 1)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Agent hours</span>
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground">{hours(usage.agentSeconds)}</span>
            {plan.agentHours === null ? " used" : ` of ${plan.agentHours} h`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Agent hours used"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 overflow-hidden rounded-full bg-white/[0.06]"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", share >= 1 ? "bg-warning" : "bg-primary")}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {dateFormat.format(new Date(usage.periodStart))} – {dateFormat.format(lastDay)} (UTC). Resets on{" "}
          {dateFormat.format(new Date(usage.periodEnd))}.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Agent runs" value={usage.runs} />
        <Stat label="Threads with runs" value={usage.threads} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-4 py-3">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
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
  const usage = useQuery({ ...queries.usage(), refetchInterval: REFRESH_MS })
  const boxes = useQuery(queries.boxes())
  const plan = PLANS.find((p) => p.id === CURRENT_PLAN)!

  return (
    <>
      <DialogTitle>Usage</DialogTitle>
      <DialogDescription>
        {plan.name} plan
        {boxes.data && ` · ${boxName(boxes.data.activeBoxId, boxes.data)}`}
      </DialogDescription>
      {usage.error && <Alert>{errorText(usage.error)}</Alert>}
      {usage.isPending && <div className="text-muted-foreground">Loading usage…</div>}
      {usage.data && <UsageSummary usage={usage.data} plan={plan} />}
      <Button asChild variant="ghost" size="sm" className="self-end">
        <Link to="/settings/billing" onClick={onClose}>
          Plans and billing
        </Link>
      </Button>
    </>
  )
}

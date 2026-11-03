import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { CliProvider } from "@cloudagents/protocol"
import { USAGE_REFRESH_MS, UsageQuotas, resetActionOf, usageSubtitle } from "@cloudagents/ui/usage"
import { useNavigate } from "react-router-dom"
import { api } from "@/api/client"
import { keys, queries, queryClient } from "@/api/queries"
import { boxName } from "@/components/BoxPicker"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { errorText } from "@/util"

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

/** The data side of the shared `UsageQuotas`; the phone app has its own (packages/mobile `UsageScreen`). */
function UsagePanelBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const usage = useQuery({ ...queries.providerUsage(), refetchInterval: USAGE_REFRESH_MS })
  const activity = useQuery({ ...queries.usageActivity(), refetchInterval: USAGE_REFRESH_MS })
  const boxes = useQuery(queries.boxes())
  const spendReset = useMutation({
    mutationFn: ({ provider, resetId }: { provider: CliProvider; resetId: string }) =>
      api.useBankedReset(provider, { resetId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: keys.providerUsage }),
  })

  return (
    <>
      <div className="flex items-baseline justify-between gap-4 pr-8">
        <DialogTitle>Quotas</DialogTitle>
        <DialogDescription>
          {usageSubtitle(boxes.data ? boxName(boxes.data.activeBoxId, boxes.data) : null, usage.data?.length ?? null)}
        </DialogDescription>
      </div>
      <UsageQuotas
        usage={usage.data}
        usageError={usage.error ? errorText(usage.error) : null}
        updatedAt={usage.dataUpdatedAt}
        activity={activity.data?.days}
        activityError={activity.error ? errorText(activity.error) : null}
        resetAction={resetActionOf(spendReset)}
        onUseReset={(provider, resetId) => spendReset.mutate({ provider, resetId })}
        onOpenConnections={() => {
          onClose()
          navigate("/settings/connections")
        }}
      />
    </>
  )
}

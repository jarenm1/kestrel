"use dom"

import { IS_DOM, type DOMProps } from "expo/dom"
import type { CliProvider } from "@cloudagents/protocol"
import { UsageQuotas, type UsageQuotasProps } from "@cloudagents/ui/usage"
import "@cloudagents/ui/dom.css"
import { domHostReset } from "./domHostReset"

/** Callbacks cross Expo's DOM bridge as async native actions; everything else is plain JSON. */
export interface UsageQuotasDomProps extends Omit<UsageQuotasProps, "onUseReset" | "onOpenConnections"> {
  onUseReset: (provider: CliProvider, resetId: string) => Promise<void>
  onOpenConnections: () => Promise<void>
  dom?: DOMProps
}

/**
 * The desktop's quotas panel (`@cloudagents/ui/usage`) as a DOM component: rendered in place on phone web, and in a
 * WebView sized to its content on iOS/Android. `UsageScreen` owns the data.
 */
export default function UsageQuotasDom({ dom: _dom, onUseReset, onOpenConnections, ...props }: UsageQuotasDomProps) {
  return (
    <div data-kestrel-dom="">
      {IS_DOM && <style>{domHostReset}</style>}
      <UsageQuotas
        {...props}
        onUseReset={(provider, resetId) => void onUseReset(provider, resetId)}
        onOpenConnections={() => void onOpenConnections()}
      />
    </div>
  )
}

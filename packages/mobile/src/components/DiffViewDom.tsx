"use dom"

import { IS_DOM, type DOMProps } from "expo/dom"
import { DiffView, type DiffViewProps } from "@cloudagents/ui/diff"
import "@cloudagents/ui/dom.css"
import { domFillReset } from "./domHostReset"

export interface DiffViewDomProps extends Omit<DiffViewProps, "onRefresh"> {
  onRefresh: () => Promise<void>
  dom?: DOMProps
}

/**
 * The desktop's diff (`@cloudagents/ui/diff`) as a DOM component: it fills the panel and scrolls itself, rendered in
 * place on phone web and in a WebView on iOS/Android. `DiffPanel` owns the data.
 */
export default function DiffViewDom({ dom: _dom, onRefresh, ...props }: DiffViewDomProps) {
  return (
    <div data-kestrel-dom="" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}>
      {IS_DOM && <style>{domFillReset}</style>}
      <DiffView {...props} onRefresh={() => void onRefresh()} />
    </div>
  )
}

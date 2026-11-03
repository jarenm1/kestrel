"use dom"

import { IS_DOM, type DOMProps } from "expo/dom"
import type { TaskStatsSample } from "@cloudagents/protocol"
import { ThreadGraphs } from "@cloudagents/ui/graphs"
import "@cloudagents/ui/dom.css"
import { domHostReset } from "./domHostReset"

/**
 * The desktop's resource graphs (`@cloudagents/ui/graphs`) as a DOM component, sized to its content in the native
 * WebView so the Desktop tab's `ScrollView` scrolls past it. `DesktopViewer` streams the samples.
 */
export default function ThreadGraphsDom({ samples }: { samples: readonly TaskStatsSample[]; dom?: DOMProps }) {
  return (
    <div data-kestrel-dom="">
      {IS_DOM && <style>{domHostReset}</style>}
      <ThreadGraphs samples={samples} />
    </div>
  )
}

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Outlet } from "react-router-dom"
import { isUnreachableError } from "@/api/errors"
import { queries } from "@/api/queries"
import { FloatingNotices } from "@/components/FloatingNotice"
import { ReconnectBanner } from "@/components/ReconnectBanner"
import { ThreadSidebar } from "@/components/ThreadSidebar"
import { DesktopTranscriptHost } from "@/components/TranscriptHost"
import { UsagePanelProvider } from "@/components/UsagePanel"
import { useThreadListEvents } from "@/hooks/useThreadListEvents"

const COLLAPSED_KEY = "kestrel.threadsCollapsed"

/**
 * Every signed-in page: the user's threads as a strip on the page background, and the page itself in a raised panel
 * beside it, inset the same distance from the top and bottom of the window. With the strip collapsed the Kestrel mark
 * in its rail expands it again, like the thread view's right rail.
 */
export function WorkspaceLayout() {
  const tasks = useQuery(queries.tasks())
  useThreadListEvents()
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1")
  useEffect(() => {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1")
    else localStorage.removeItem(COLLAPSED_KEY)
  }, [collapsed])

  return (
    <UsagePanelProvider>
      <DesktopTranscriptHost>
        <div className="flex h-full flex-col">
          <div className="flex min-h-0 flex-1 pt-3">
            <ThreadSidebar
              tasks={tasks.data}
              error={isUnreachableError(tasks.error) ? null : tasks.error}
              collapsed={collapsed}
              onCollapse={() => setCollapsed(true)}
              onExpand={() => setCollapsed(false)}
            />
            <div className="relative mr-3 mb-3 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-soft">
              <FloatingNotices>
                <ReconnectBanner />
              </FloatingNotices>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Outlet />
              </div>
            </div>
          </div>
        </div>
      </DesktopTranscriptHost>
    </UsagePanelProvider>
  )
}

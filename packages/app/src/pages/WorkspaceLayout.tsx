import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Outlet } from "react-router-dom"
import { PanelLeftOpen } from "lucide-react"
import { queries } from "@/api/queries"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { ThreadSidebar } from "@/components/ThreadSidebar"
import { Button } from "@/components/ui/button"

const COLLAPSED_KEY = "kestrel.threadsCollapsed"

/**
 * Every signed-in page: the user's threads as a strip on the page background, and the page itself in a raised panel
 * beside it, inset the same distance from the top and bottom of the window. With the strip collapsed, the panel has
 * a slim left rail holding the button that expands it, like the thread view's right rail.
 */
export function WorkspaceLayout() {
  const tasks = useQuery(queries.tasks())
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1")
  useEffect(() => {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, "1")
    else localStorage.removeItem(COLLAPSED_KEY)
  }, [collapsed])

  return (
    <div className="flex h-full flex-col">
      <BoxOfflineBanner className="mx-3 mt-3 w-auto" />
      <div className="flex min-h-0 flex-1 pt-3">
        <ThreadSidebar
          tasks={tasks.data}
          error={tasks.error}
          collapsed={collapsed}
          onCollapse={() => setCollapsed(true)}
        />
        <div className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-soft">
          {collapsed && (
            <aside className="flex w-[3.25rem] shrink-0 flex-col items-center py-2">
              <Button variant="ghost" size="icon" aria-label="Expand threads" onClick={() => setCollapsed(false)}>
                <PanelLeftOpen />
              </Button>
            </aside>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  )
}

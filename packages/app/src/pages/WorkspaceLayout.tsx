import { useQuery } from "@tanstack/react-query"
import { Outlet } from "react-router-dom"
import { queries } from "@/api/queries"
import { BoxOfflineBanner } from "@/components/BoxStatus"
import { ThreadSidebar } from "@/components/ThreadSidebar"

/**
 * Every signed-in page except connections: the user's threads as a rail on the page background, and the page itself
 * in a raised panel beside it.
 */
export function WorkspaceLayout() {
  const tasks = useQuery(queries.tasks())

  return (
    <>
      <BoxOfflineBanner className="mx-3 mb-2 w-auto" />
      <div className="flex min-h-0 flex-1">
        <ThreadSidebar tasks={tasks.data} error={tasks.error} />
        <div className="mr-3 mb-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-soft">
          <Outlet />
        </div>
      </div>
    </>
  )
}

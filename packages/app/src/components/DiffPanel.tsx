import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { CheckoutDiff } from "@cloudagents/protocol"
import type { FileDiffMetadata } from "@pierre/diffs/types"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { DiffFileList, isLargeDiffFile } from "@/components/DiffFiles"
import { diffFileKey, diffFileStats, parseDiff, patchCacheKey } from "@/lib/pierreDiff"
import { errorText } from "@/util"

/**
 * The thread's changes, one section per checked-out repository: every change on that checkout's branch (commits,
 * uncommitted and untracked files) against its base branch. Refetched when the thread's run events invalidate it.
 */
export function DiffPanel({ taskId }: { taskId: string }) {
  const diff = useQuery(queries.diff(taskId))
  const checkouts = diff.data?.checkouts ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-end px-4 pb-2">
        <Button variant="soft" size="sm" onClick={() => void diff.refetch()} disabled={diff.isFetching}>
          {diff.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {diff.error && <Alert className="mx-3 mb-2 w-auto">{errorText(diff.error)}</Alert>}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
        {diff.isPending && <p className="text-muted-foreground">Loading…</p>}
        {diff.isSuccess && checkouts.length === 0 && (
          <p className="text-muted-foreground">
            No repository checked out yet. The agent checks repos out when the work needs one.
          </p>
        )}
        {checkouts.map((checkout) => (
          <CheckoutDiffSection key={checkout.checkoutId} checkout={checkout} />
        ))}
      </div>
    </div>
  )
}

/**
 * One checkout's changes as a scrollable buffer with a collapsible section per file. Open/closed state lives here, not
 * in the panel, because the same file path can appear under two repositories.
 */
function CheckoutDiffSection({ checkout }: { checkout: CheckoutDiff }) {
  const parsed = useMemo(
    () => parseDiff(checkout.diff, patchCacheKey(`checkout:${checkout.checkoutId}`, checkout.diff)),
    [checkout.diff, checkout.checkoutId],
  )
  const files = parsed.files
  // Explicit open/closed choices by file; files without one use their default (large files closed).
  const [collapsedByKey, setCollapsedByKey] = useState<ReadonlyMap<string, boolean>>(new Map())

  const isCollapsed = (file: FileDiffMetadata): boolean => collapsedByKey.get(diffFileKey(file)) ?? isLargeDiffFile(file)
  const anyExpanded = files.some((f) => !isCollapsed(f))
  const additions = files.reduce((n, f) => n + diffFileStats(f).additions, 0)
  const deletions = files.reduce((n, f) => n + diffFileStats(f).deletions, 0)

  function setAll(collapsed: boolean) {
    setCollapsedByKey(new Map(files.map((f) => [diffFileKey(f), collapsed])))
  }

  function toggle(file: FileDiffMetadata) {
    setCollapsedByKey((prev) => new Map(prev).set(diffFileKey(file), !isCollapsed(file)))
  }

  return (
    <section className="flex shrink-0 flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <span className="truncate font-medium text-foreground">{checkout.repo}</span>
          <span className="truncate">
            {files.length} {files.length === 1 ? "file" : "files"} vs {checkout.baseBranch}
          </span>
          <span className="font-mono text-success">+{additions}</span>
          <span className="font-mono text-destructive">−{deletions}</span>
        </span>
        <span className="flex-1" />
        {files.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => setAll(anyExpanded)}>
            {anyExpanded ? "Collapse all" : "Expand all"}
          </Button>
        )}
      </div>
      <DiffFileList
        files={files}
        binary={parsed.binary}
        isCollapsed={isCollapsed}
        onToggle={toggle}
      />
    </section>
  )
}

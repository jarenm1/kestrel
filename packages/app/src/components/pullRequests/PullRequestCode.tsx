import { useEffect, useId, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { FileDiffMetadata } from "@pierre/diffs/types"
import { queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DiffFileList, isLargeDiffFile } from "@/components/DiffFiles"
import { diffFileKey, displayPath, parseDiff, patchCacheKey } from "@/lib/pierreDiff"
import { errorText } from "@/util"

/** Viewed files live per pull request head: a new push makes every file unviewed again. */
const viewedStorageKey = (repo: string, number: number, headRef: string) =>
  `kestrel.prViewed.${repo.toLowerCase()}#${number}@${headRef}`

function readViewed(key: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return new Set(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : [])
  } catch {
    return new Set()
  }
}

/**
 * The pull request's unified diff, one collapsible section per file, each with a Viewed mark kept in localStorage for
 * this head. The diff is only read while this tab is open.
 */
export function PullRequestCode({
  taskId,
  repo,
  number,
  headRef,
  active,
}: {
  taskId: string
  repo: string
  number: number
  headRef: string
  active: boolean
}) {
  const diff = useQuery({ ...queries.pullRequestDiff(taskId, repo, number), enabled: active })
  const parsed = useMemo(
    () =>
      diff.data === undefined
        ? { files: [], binary: new Set<string>() }
        : parseDiff(diff.data.patch, patchCacheKey(`pr:${repo}#${number}@${headRef}`, diff.data.patch)),
    [diff.data, repo, number, headRef],
  )
  const files = parsed.files
  const storageKey = viewedStorageKey(repo, number, headRef)
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => readViewed(storageKey))
  const [collapsedByKey, setCollapsedByKey] = useState<ReadonlyMap<string, boolean>>(new Map())

  // Another pull request (or a new head) has its own Viewed set.
  useEffect(() => {
    setViewed(readViewed(storageKey))
    setCollapsedByKey(new Map())
  }, [storageKey])

  const isCollapsed = (file: FileDiffMetadata): boolean => collapsedByKey.get(diffFileKey(file)) ?? isLargeDiffFile(file)

  function toggleViewed(file: FileDiffMetadata, next: boolean) {
    const key = diffFileKey(file)
    const updated = new Set(viewed)
    if (next) updated.add(key)
    else updated.delete(key)
    setViewed(updated)
    localStorage.setItem(storageKey, JSON.stringify([...updated]))
  }

  return (
    <div className="flex flex-col gap-2">
      {diff.data?.truncated === true && (
        <p className="text-xs text-warning">
          This diff was shortened because the pull request is too large; the rest is on GitHub.
        </p>
      )}
      {diff.error && (
        <Alert className="w-auto">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{errorText(diff.error)}</span>
            <Button variant="soft" size="sm" onClick={() => void diff.refetch()} disabled={diff.isFetching}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {diff.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
      {diff.data !== undefined && (
        <DiffFileList
          files={files}
          binary={parsed.binary}
          isCollapsed={isCollapsed}
          onToggle={(file) =>
            setCollapsedByKey((prev) => new Map(prev).set(diffFileKey(file), !isCollapsed(file)))
          }
          fileAction={(file) => (
            <ViewedToggle
              path={displayPath(file)}
              checked={viewed.has(diffFileKey(file))}
              onChange={(next) => toggleViewed(file, next)}
            />
          )}
        />
      )}
    </div>
  )
}

function ViewedToggle({
  path,
  checked,
  onChange,
}: {
  path: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex shrink-0 items-center gap-1.5 pl-2 font-sans">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(state) => onChange(state === true)}
        aria-label={`Mark ${path} as viewed`}
        className="size-3.5"
      />
      <label htmlFor={id} className="cursor-pointer text-xs text-muted-foreground select-none">
        Viewed
      </label>
    </div>
  )
}

import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { Schema } from "effect"
import { GithubRepoSlug, type BoxList, type SendMessageBody, type Task } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries, storeTask } from "@/api/queries"
import { BoxPicker, KESTREL_BOX, useBoxHealth } from "@/components/BoxPicker"
import { BoxProblem } from "@/components/Boxes"
import { Composer } from "@/components/Composer"
import { BranchPicker, RepoPicker } from "@/components/RepoPicker"
import { useStoredChoice } from "@/hooks/useStoredChoice"
import { githubReferenceLabel, parseGithubReferenceDraft } from "@cloudagents/composer/reference"
import { threadPath } from "@/routes"
import { repoShortName, threadTitle } from "@/util"

/**
 * The box a new thread goes to: the stored pick while it is still in the list, else the active box. `undefined` while
 * the box list loads (then `createTask` uses the active box).
 */
function chosenBox(stored: string | undefined, list: BoxList | undefined): string | null | undefined {
  if (list === undefined) return undefined
  if (stored === KESTREL_BOX) return null
  return list.boxes.some((box) => box.id === stored) ? (stored ?? null) : list.activeBoxId
}

/**
 * Chat home: the first message creates a thread (task), sends the message to it and opens it. The bar under the box
 * picks the repository the thread is about (the agent then picks what to check out), the branch if the user wants to
 * decide that (the thread starts with it checked out) and, for users with boxes of their own, the box it runs on;
 * that pick leaves the active box as it is.
 */
export function NewThreadPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [repo, setRepo] = useStoredChoice("kestrel.newThreadRepo", GithubRepoSlug)
  // Branch to start from; `undefined` leaves it to the agent. A different repository goes back to that.
  const [branch, setBranch] = useState<string | undefined>()
  const [storedBox, setStoredBox] = useStoredChoice("kestrel.newThreadBox", Schema.String)
  const boxes = useQuery(queries.boxes())
  const boxId = chosenBox(storedBox, boxes.data)
  const boxHealth = useBoxHealth(boxId ?? null, boxes.data)
  const boxUrl = boxId ? boxes.data?.boxes.find((box) => box.id === boxId)?.url : undefined
  // The thread created by an earlier attempt and what it was created with; a retry after a failed send reuses it
  // instead of creating another, unless the repository, branch or box was changed since.
  const created = useRef<{
    task: Task
    repo: string | undefined
    branch: string | undefined
    boxId: string | null | undefined
  } | null>(null)

  const start = useMutation({
    mutationFn: async ({ body, files }: { body: SendMessageBody; files: readonly File[] }) => {
      // The first line is the provisional title; the box replaces it once the first message is accepted.
      const titleText = parseGithubReferenceDraft(body.text)
        .map((segment) => segment.type === "text" ? segment.text : githubReferenceLabel(segment.reference.kind, segment.reference.number))
        .join("")
      const title = threadTitle(titleText) || threadTitle(files[0]?.name ?? "")
      const previous = created.current
      let task: Task
      if (previous !== null && previous.repo === repo && previous.branch === branch && previous.boxId === boxId) {
        task = previous.task
      } else if (boxHealth?.state === "offline") {
        throw new Error("That box is offline. Pick another box or start it first.")
      } else if (boxHealth?.state === "outdated" || boxHealth?.state === "rejected") {
        throw new Error("That box cannot run threads until it is fixed. Pick another box, or see Settings › Boxes.")
      } else {
        const target = repo === undefined ? {} : branch === undefined ? { pickedRepo: repo } : { checkout: { repo, baseBranch: branch } }
        task = await api.createTask({ title, generateTitle: true, ...target }, boxId)
      }
      created.current = { task, repo, branch, boxId }
      // The thread exists from here on, even if the message below fails.
      storeTask(queryClient, task)
      return { task, sent: await api.sendMessage(task.id, body, files) }
    },
    onSuccess: ({ task, sent }) => {
      queryClient.setQueryData(keys.messages(task.id), [sent.message])
      queryClient.setQueryData(keys.runs(task.id), [sent.run])
      navigate(threadPath(task.id))
    },
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-center text-xl font-semibold tracking-tight">What should we work on?</h1>
      <div className="flex w-full max-w-3xl flex-col">
        <Composer
          onSend={async (body, files) => { await start.mutateAsync({ body, files }) }}
          pending={start.isPending}
          error={start.error}
          draftKey="new"
          repo={repo}
          onRepoChange={(next) => {
            if (next !== repo) setBranch(undefined)
            setRepo(next)
          }}
          placeholder={
            repo === undefined
              ? "Ask for anything — the agent checks out the repos it needs"
              : `Ask for anything in ${repoShortName(repo)}`
          }
          autoFocus
        />
        <div className="mx-4 flex min-w-0 items-center gap-2 rounded-b-xl bg-input px-1.5 py-1 text-xs text-muted-foreground shadow-well">
          <RepoPicker
            value={repo}
            onChange={(next) => {
              if (next !== repo) setBranch(undefined)
              setRepo(next)
            }}
            disabled={start.isPending}
          />
          {repo !== undefined && (
            <BranchPicker repo={repo} value={branch} onChange={setBranch} disabled={start.isPending} />
          )}
          <span className="flex-1" />
          {boxes.data && boxes.data.boxes.length > 0 && boxId !== undefined && (
            <BoxPicker
              value={boxId}
              list={boxes.data}
              onChange={(next) => setStoredBox(next ?? KESTREL_BOX)}
              disabled={start.isPending}
            />
          )}
        </div>
        {boxUrl !== undefined && (
          <BoxProblem health={boxHealth} url={boxUrl} className="mx-4 mt-2 text-xs text-muted-foreground" />
        )}
      </div>
    </div>
  )
}

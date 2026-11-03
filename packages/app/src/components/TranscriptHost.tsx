import { useMemo, useState, type MouseEvent, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { TranscriptHostProvider, type FileLink, type TranscriptHost } from "@cloudagents/ui/transcript/host"
import { queries } from "@/api/queries"
import { threadPath } from "@/routes"

/**
 * A box file's URL from the query cache. On a user's own box the URL carries a box token that expires after an hour,
 * while the transcript can stay mounted far longer: a click asks for a fresh URL first, and an image that fails to
 * load (it scrolled into view after the token expired) asks once per URL.
 */
function useDesktopFileLink(taskId: string, path: string): FileLink {
  const queryClient = useQueryClient()
  const options = queries.taskFileUrl(taskId, path)
  const { data: url, refetch } = useQuery(options)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return {
    url,
    onError: () => {
      if (url === undefined || failedUrl === url) return
      setFailedUrl(url)
      void refetch()
    },
    onOpen: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      // Opened before the await, while the click still allows a new tab; pointed at the file once the URL is fresh.
      const tab = window.open("", "_blank")
      if (tab === null) return
      tab.opener = null
      queryClient
        .fetchQuery({ ...options, staleTime: 0 })
        .then((fresh) => tab.location.replace(fresh))
        .catch(() => tab.close())
    },
  }
}

/** The shared transcript's view of the desktop app: the query cache for file URLs, the router for threads. */
export function DesktopTranscriptHost({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const host = useMemo<TranscriptHost>(
    () => ({ useFileLink: useDesktopFileLink, openExternal: undefined, openThread: (id) => navigate(threadPath(id)) }),
    [navigate],
  )
  return <TranscriptHostProvider value={host}>{children}</TranscriptHostProvider>
}

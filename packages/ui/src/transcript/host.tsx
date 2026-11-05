import { createContext, useContext, type MouseEvent } from "react"

/** A box file (attachment, tool screenshot) as the transcript shows it. */
export interface FileLink {
  /** Undefined while the host is still resolving it (e.g. minting a token). */
  readonly url: string | undefined
  /** The image failed to load: its URL's token may have expired, so the host should resolve a fresh one. */
  readonly onError: () => void
  /** A click on the file's link; the host may open it itself (fresh token, native browser) and prevent the default. */
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>) => void
}

/**
 * What the transcript needs from the app around it. The desktop provides it with its query cache and router; the phone
 * app's DOM component provides it with data the native side passes in.
 */
export interface TranscriptHost {
  /** A hook: the URL of a file the thread's box serves (`Paths.taskAttachment`, `Paths.taskRunImage`). */
  readonly useFileLink: (taskId: string, path: string) => FileLink
  /** Opens a link from agent text in a new window. Undefined: the anchor's own `target="_blank"` does it. */
  readonly openExternal: ((url: string) => void) | undefined
  /** Opens another of the user's threads in the app. */
  readonly openThread: (taskId: string) => void
}

const UNRESOLVED: FileLink = { url: undefined, onError: () => {}, onOpen: () => {} }

const TranscriptHostContext = createContext<TranscriptHost>({
  useFileLink: () => UNRESOLVED,
  openExternal: undefined,
  openThread: () => {},
})

export const TranscriptHostProvider = TranscriptHostContext.Provider

export const useTranscriptHost = () => useContext(TranscriptHostContext)

/** Thread URLs are the same in the desktop app and on phone web. */
export const threadHref = (taskId: string) => `/c/${encodeURIComponent(taskId)}`

/** A plain left click, which the app handles itself; modified clicks keep the browser's behaviour (new tab, ...). */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** Click handler for an external link: hands plain clicks to `openExternal` when the host has one. */
export function externalClick(host: TranscriptHost, url: string | undefined) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (host.openExternal === undefined || url === undefined || !isPlainClick(event)) return
    event.preventDefault()
    host.openExternal(url)
  }
}

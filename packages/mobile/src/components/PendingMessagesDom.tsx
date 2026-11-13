"use dom"

import { useMemo } from "react"
import { IS_DOM, type DOMProps } from "expo/dom"
import type { Message } from "@cloudagents/protocol"
import { PendingMessages } from "@cloudagents/ui/transcript/pending"
import { TranscriptHostProvider, type TranscriptHost } from "@cloudagents/ui/transcript/host"
import "@cloudagents/ui/dom.css"
import { domHostReset } from "./domHostReset"

/** How a box file is fetched without the native session header: `${base}${path}${query}`. */
export interface DomFileAccess {
  readonly base: string
  readonly query: string
}

/** Callbacks cross Expo's DOM bridge as async native actions; everything else is plain JSON. */
export interface PendingMessagesDomProps {
  taskId: string
  /** The thread's messages whose `pending` is set. */
  messages: readonly Message[]
  /** Null while the native side resolves it; attachment thumbnails then stay blank. */
  files: DomFileAccess | null
  onRemove: (messageId: string) => Promise<unknown>
  onSendHeld: () => Promise<unknown>
  /** An attachment image failed to load; its token may have expired. */
  onFileError: () => Promise<void>
  /** Opens a file in the system browser (native only; phone web follows the anchor). */
  onOpenExternal: (url: string) => Promise<void>
  dom?: DOMProps
}

/**
 * The desktop's pending-message strip (`@cloudagents/ui/transcript/pending`) as a DOM component. It is sized to its
 * content, bounded so a long line scrolls inside it instead of pushing the composer away; `ChatPanel` owns the queries
 * and mutations.
 */
export default function PendingMessagesDom({
  taskId,
  messages,
  files,
  onRemove,
  onSendHeld,
  onFileError,
  onOpenExternal,
}: PendingMessagesDomProps) {
  const host = useMemo<TranscriptHost>(
    () => ({
      useFileLink: (_taskId, path) => {
        const url = files === null ? undefined : `${files.base}${path}${files.query}`
        return {
          url,
          onError: () => void onFileError(),
          onOpen: (event) => {
            // In the native WebView a new tab cannot open; the system browser shows the file instead.
            if (!IS_DOM || url === undefined) return
            event.preventDefault()
            void onOpenExternal(url)
          },
        }
      },
      openExternal: IS_DOM ? (url) => void onOpenExternal(url) : undefined,
      openThread: () => {},
      forkThread: undefined,
    }),
    [files, onFileError, onOpenExternal],
  )

  return (
    <div data-kestrel-dom="">
      {IS_DOM && <style>{domHostReset}</style>}
      <TranscriptHostProvider value={host}>
        <PendingMessages
          taskId={taskId}
          messages={messages}
          onRemove={onRemove}
          onSendHeld={onSendHeld}
          className="px-4 pb-2"
        />
      </TranscriptHostProvider>
    </div>
  )
}

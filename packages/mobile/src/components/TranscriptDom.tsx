"use dom"

import { useEffect, useMemo, useRef, useState, type Ref } from "react"
import { IS_DOM, useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from "expo/dom"
import { Transcript } from "@cloudagents/ui/transcript"
import { TranscriptHostProvider, type TranscriptHost } from "@cloudagents/ui/transcript/host"
import "@cloudagents/ui/dom.css"
import { applyTranscriptPatch, type TranscriptData, type TranscriptPatch, type TranscriptSnapshot } from "@/lib/transcriptBridge"
import { domFillReset } from "./domHostReset"

/** How a box file is fetched without the native session header: `${base}${path}${query}`. */
export interface DomFileAccess {
  readonly base: string
  readonly query: string
}

/** The native side's handle; arguments cross the bridge as JSON and return values are discarded. */
export interface TranscriptDomHandle {
  patch(patch: TranscriptPatch): void
}

export type TranscriptDomRef = TranscriptDomHandle & DOMImperativeFactory

export interface TranscriptDomProps {
  ref: Ref<TranscriptDomRef>
  /** The whole thread, replaced (a new epoch) when the native side resyncs. */
  snapshot: TranscriptSnapshot
  /** Null while the native side resolves it; files then stay hidden. */
  files: DomFileAccess | null
  /** Asks for a new snapshot: on mount, and when a patch is missing (a seq gap). */
  onResync: () => Promise<void>
  /** An image failed to load; its token may have expired. */
  onFileError: () => Promise<void>
  /** Opens a URL in the system browser (native only; phone web follows the anchor). */
  openExternal: (url: string) => Promise<void>
  openThread: (taskId: string) => Promise<void>
  dom?: DOMProps
}

/**
 * The desktop's chat transcript (`@cloudagents/ui/transcript`) as a DOM component. It scrolls itself and keeps its
 * own copy of the thread: a snapshot per epoch, then patches through the ref (see `lib/transcriptBridge`).
 */
export default function TranscriptDom({
  ref,
  snapshot,
  files,
  onResync,
  onFileError,
  openExternal,
  openThread,
}: TranscriptDomProps) {
  const [state, setState] = useState<{ epoch: number; seq: number; data: TranscriptData }>(() => ({
    epoch: snapshot.epoch,
    seq: 0,
    data: snapshot,
  }))
  const latest = useRef(state)
  latest.current = state
  const actions = useRef({ onResync, onFileError, openExternal, openThread })
  actions.current = { onResync, onFileError, openExternal, openThread }

  // A new epoch replaces everything, including patches applied on top of the previous one.
  if (snapshot.epoch !== state.epoch) {
    const next = { epoch: snapshot.epoch, seq: 0, data: snapshot }
    latest.current = next
    setState(next)
  }

  useEffect(() => {
    void actions.current.onResync()
  }, [])

  useDOMImperativeHandle(
    ref,
    () => ({
      patch(raw) {
        const patch = raw as unknown as TranscriptPatch
        const current = latest.current
        if (patch.epoch !== current.epoch) return
        if (patch.seq !== current.seq + 1) {
          void actions.current.onResync()
          return
        }
        const next = { epoch: current.epoch, seq: patch.seq, data: applyTranscriptPatch(current.data, patch) }
        latest.current = next
        setState(next)
      },
    }) as TranscriptDomRef,
    [],
  )

  const host = useMemo<TranscriptHost>(
    () => ({
      useFileLink: (_taskId, path) => {
        const url = files === null ? undefined : `${files.base}${path}${files.query}`
        return {
          url,
          onError: () => void actions.current.onFileError(),
          onOpen: (event) => {
            // In the native WebView a new tab cannot open; the system browser shows the file instead.
            if (!IS_DOM || url === undefined) return
            event.preventDefault()
            void actions.current.openExternal(url)
          },
        }
      },
      openExternal: IS_DOM ? (url) => void actions.current.openExternal(url) : undefined,
      openThread: (taskId) => void actions.current.openThread(taskId),
    }),
    [files],
  )

  const { data } = state
  return (
    <div data-kestrel-dom="" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}>
      {IS_DOM && <style>{domFillReset}</style>}
      <TranscriptHostProvider value={host}>
        <Transcript
          taskId={data.taskId}
          messages={data.messages}
          runs={data.runs}
          runItems={data.runItems}
          pendingAskId={data.pendingAskId}
        />
      </TranscriptHostProvider>
    </div>
  )
}

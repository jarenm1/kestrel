"use dom"

import { useEffect, useMemo, useRef, useState, type Ref, type TouchEvent } from "react"
import { IS_DOM, useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from "expo/dom"
import { Transcript } from "@cloudagents/ui/transcript"
import { TranscriptHostProvider, type TranscriptHost } from "@cloudagents/ui/transcript/host"
import "@cloudagents/ui/dom.css"
import { applyTranscriptPatch, type TranscriptData, type TranscriptPatch, type TranscriptSnapshot } from "@/lib/transcriptBridge"
import { endSwipe, moveSwipe, startSwipe, type SwipeDirection, type SwipeTrack } from "@/lib/swipe"
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
  /** Forks the thread at an agent reply and opens the fork; failures are the native side's to show. */
  forkThread: (taskId: string, messageId: string) => Promise<void>
  /**
   * A horizontal swipe finished over the transcript. Native only: the WebView takes the touch, so the screen's own
   * swipe gestures never see it. On phone web the transcript is in the page, and those gestures see it directly.
   */
  onSwipe: (direction: SwipeDirection) => Promise<void>
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
  forkThread,
  onSwipe,
}: TranscriptDomProps) {
  const [state, setState] = useState<{ epoch: number; seq: number; data: TranscriptData }>(() => ({
    epoch: snapshot.epoch,
    seq: 0,
    data: snapshot,
  }))
  const latest = useRef(state)
  latest.current = state
  const actions = useRef({ onResync, onFileError, openExternal, openThread, forkThread, onSwipe })
  actions.current = { onResync, onFileError, openExternal, openThread, forkThread, onSwipe }
  const swipe = useRef<SwipeTrack | null>(null)

  // A new epoch replaces everything, including patches applied on top of the previous one.
  if (snapshot.epoch !== state.epoch) {
    const next = { epoch: snapshot.epoch, seq: 0, data: snapshot }
    latest.current = next
    setState(next)
  }

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

  // After `useDOMImperativeHandle`'s effect: on native it posts the handle's method names to the WebView wrapper, and
  // this message must follow it, since the native side starts sending patches once it has asked for a snapshot.
  useEffect(() => {
    void actions.current.onResync()
  }, [])

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
      forkThread: (taskId, messageId) => actions.current.forkThread(taskId, messageId),
    }),
    [files],
  )

  const { data } = state
  const touch = (event: TouchEvent) => event.changedTouches[0]
  return (
    <div
      data-kestrel-dom=""
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}
      onTouchStart={
        IS_DOM
          ? (event) => {
              const t = touch(event)
              swipe.current =
                t === undefined || scrollsSideways(event.target, event.currentTarget)
                  ? null
                  : startSwipe(t.clientX, t.clientY, event.timeStamp)
            }
          : undefined
      }
      onTouchMove={
        IS_DOM
          ? (event) => {
              const t = touch(event)
              if (swipe.current !== null && t !== undefined) moveSwipe(swipe.current, t.clientX, t.clientY)
            }
          : undefined
      }
      onTouchEnd={
        IS_DOM
          ? (event) => {
              const t = touch(event)
              const direction = swipe.current && t ? endSwipe(swipe.current, t.clientX, event.timeStamp) : null
              swipe.current = null
              if (direction !== null) void actions.current.onSwipe(direction)
            }
          : undefined
      }
    >
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

/** A touch inside something that scrolls sideways (a wide code block or table) belongs to it, not to the screen. */
function scrollsSideways(target: EventTarget, root: Element): boolean {
  for (let el = target instanceof Element ? target : null; el !== null && el !== root; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowX
    if ((overflow === "auto" || overflow === "scroll") && el.scrollWidth > el.clientWidth) return true
  }
  return false
}

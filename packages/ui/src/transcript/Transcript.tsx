import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react"
import { transcriptSegments, type AgentItem, type Message, type Run } from "@cloudagents/protocol"
import { githubReferenceLabel, githubReferenceUrl } from "@cloudagents/composer/reference"
import { parseComposerDraft } from "@cloudagents/composer/models"
import { MODEL_LOGOS } from "../harness-logos"
import CircleDot from "lucide-react/icons/circle-dot"
import GitPullRequest from "lucide-react/icons/git-pull-request"
import { cn } from "../cn"
import { externalClick, isPlainClick, threadHref, useTranscriptHost } from "./host"
import { Markdown } from "./Markdown"
import { MessageAttachments } from "./MessageAttachments"
import { RunTranscript } from "./RunTranscript"
import { RunSummary } from "./RunSummary"
import { formatMessageTime } from "./time"

const ENTER_CLASS = "animate-in duration-300 fade-in slide-in-from-bottom-1"

/** Within this distance of the bottom, keep following new content. */
const STICK_PX = 80

const NO_ITEMS: readonly AgentItem[] = []

/** Under an agent reply: the time it was sent. */
function MessageTime({ iso }: { iso: string }) {
  return <div className="mt-1.5 text-[11px] text-muted-foreground"><time dateTime={iso}>{formatMessageTime(iso)}</time></div>
}

/** Sent messages preserve plain text while displaying both reference and model tokens as their composed chips. */
function UserMessageText({ text }: { text: string }) {
  const host = useTranscriptHost()
  const segments = parseComposerDraft(text)
  if (segments.every((segment) => segment.type === "text")) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "text") return <Fragment key={index}>{segment.text}</Fragment>
        if (segment.type === "model") {
          const mention = segment.mention
          const logo = MODEL_LOGOS[mention.harness]
          return (
            <span
              key={index}
              title={`${mention.slug} · ${mention.harnessName}`}
              aria-label={`${mention.name}, ${mention.harnessName}, ${mention.slug}`}
              className="mx-px inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-white/[0.07] px-1.5 py-0.5 align-middle text-xs font-medium text-foreground"
            >
              {logo && (logo.monochrome ? (
                <span aria-hidden="true" className="size-3 shrink-0 bg-current" style={{ mask: `url("${logo.src}") center / contain no-repeat` }} />
              ) : (
                <img src={logo.src} alt="" className="size-3 shrink-0 object-contain" />
              ))}
              {mention.name}
            </span>
          )
        }
        const href = githubReferenceUrl(segment.reference)
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={externalClick(host, href)}
            className="inline-flex items-baseline gap-1 whitespace-nowrap font-semibold underline underline-offset-4"
          >
            {segment.reference.kind === "pr" ? (
              <GitPullRequest aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0 self-center" />
            ) : (
              <CircleDot aria-hidden="true" className="relative top-0.5 size-3.5 shrink-0 self-center" />
            )}
            {githubReferenceLabel(segment.reference.kind, segment.reference.number)}
          </a>
        )
      })}
    </>
  )
}

/** A link to another of the user's threads; a plain click goes through the host's navigation. */
function ThreadLink({ taskId, children }: { taskId: string; children: ReactNode }) {
  const host = useTranscriptHost()
  return (
    <a
      href={threadHref(taskId)}
      onClick={(event) => {
        if (!isPlainClick(event)) return
        event.preventDefault()
        host.openThread(taskId)
      }}
      className="font-medium hover:underline"
    >
      {children}
    </a>
  )
}

/** `children`: what hangs off a message (attachments), shown under its text. */
function ThreadItem({
  message,
  hideText = false,
  hideTime = false,
  children,
}: {
  message: Message
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean
  hideTime?: boolean
  children?: ReactNode
}) {
  switch (message.role) {
    case "user":
      return (
        <div className={cn("flex flex-col items-end", ENTER_CLASS)}>
          {/* Sent by the agent of another of the user's threads (thread_send), not typed by the user. */}
          {message.fromThread && (
            <div className="mb-1 max-w-[85%] truncate text-[11px] text-muted-foreground">
              From the agent of <ThreadLink taskId={message.fromThread.id}>{message.fromThread.title}</ThreadLink>
            </div>
          )}
          {/* A message of only attachments has no text bubble. */}
          {message.text !== "" && (
            <div className="max-w-[85%] rounded-2xl bg-white/[0.08] px-4 py-2.5 break-words whitespace-pre-wrap shadow-soft">
              <UserMessageText text={message.text} />
            </div>
          )}
          {children}
        </div>
      )
    case "agent": {
      // Keep the message clock unless the run transcript already supplies one.
      if (hideText && hideTime && (children === undefined || children === null)) return null
      return (
        <div className={ENTER_CLASS}>
          {!hideText && <Markdown text={message.text} />}
          {children}
          {!hideTime && <MessageTime iso={message.createdAt} />}
        </div>
      )
    }
    case "system":
      return (
        <div className={cn("self-center text-xs text-muted-foreground italic", ENTER_CLASS)}>
          {message.text}
          {children}
        </div>
      )
  }
}

/**
 * Plain data only (no callbacks), so the phone app can send it across Expo's DOM bridge; what the transcript needs
 * from the app (file URLs, links, navigation) comes from `TranscriptHostProvider`.
 */
export interface TranscriptProps {
  readonly taskId: string
  readonly messages: readonly Message[]
  readonly runs: readonly Run[]
  /** Each run's items in arrival order, as far as they have loaded; a run with no entry has none yet. */
  readonly runItems: Readonly<Record<string, readonly AgentItem[]>>
  /** A `task_ask` question the agent is blocked on: the composer shows it, so its text and files stay out of here. */
  readonly pendingAskId: string | undefined
  /** Classes for the scrolling element (its padding); `p-4` when omitted. */
  readonly className?: string
}

/**
 * A thread's messages, each followed by what its run showed, in a scrolling column that follows new content while the
 * reader is at the bottom.
 */
export function Transcript({ taskId, messages, runs, runItems, pendingAskId, className }: TranscriptProps) {
  const threadRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // After each user message a run took comes what the run showed until its next one, so a message that steered the run
  // (or waited in its inbox) reads at the point of the transcript where it was sent.
  const segments = transcriptSegments(sortedMessages)
  const lastReplies = new Map<string, string>()
  const finalSegments = new Map<string, string>()
  for (const message of sortedMessages) {
    if (message.runId !== null && message.role === "agent") lastReplies.set(message.runId, message.id)
    const segment = segments.get(message.id)
    if (segment?.to === null) finalSegments.set(segment.runId, message.id)
  }
  const summaries = new Map<string, Run>()
  for (const run of runs) {
    // Without items, the saved reply is still the visible answer; its footer belongs after it.
    const anchor = (runItems[run.id]?.length ?? 0) > 0
      ? finalSegments.get(run.id)
      : lastReplies.get(run.id) ?? finalSegments.get(run.id)
    if (anchor !== undefined) summaries.set(anchor, run)
  }

  useLayoutEffect(() => {
    const el = threadRef.current
    const content = contentRef.current
    if (!el || !content) return

    // A newly opened thread starts at the bottom, even if the previous thread was paused.
    atEnd.current = true
    const follow = () => {
      if (atEnd.current) el.scrollTop = el.scrollHeight
    }
    follow()
    // Also follow late layout changes, such as images loading and transcript expansion.
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
  }, [taskId])

  function onThreadScroll() {
    const el = threadRef.current
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
  }

  return (
    <div className={cn("min-h-0 flex-1 overflow-auto", className ?? "p-4")} ref={threadRef} onScroll={onThreadScroll}>
      <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
        {sortedMessages.length === 0 && (
          <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
        )}
        {sortedMessages.map((m) => {
          const segment = segments.get(m.id)
          const pending = m.id === pendingAskId
          // A question's text is not in the transcript (only its collapsed tool call), so it is never a duplicate.
          const duplicate =
            m.role === "agent" && m.options === undefined && m.runId !== null && (runItems[m.runId]?.length ?? 0) > 0
          const attachments = pending ? [] : (m.attachments ?? [])
          const summaryRun = summaries.get(m.id)
          return (
            <Fragment key={m.id}>
              <ThreadItem
                message={m}
                hideText={duplicate || pending}
                hideTime={pending || summaryRun !== undefined || (duplicate && runs.some((run) => run.id === m.runId))}
              >
                {attachments.length > 0 ? (
                  <MessageAttachments
                    taskId={taskId}
                    attachments={attachments}
                    className={m.role === "user" ? "max-w-[85%] justify-end" : undefined}
                  />
                ) : null}
              </ThreadItem>
              {segment !== undefined && (
                <>
                  <RunTranscript
                    taskId={taskId}
                    runId={segment.runId}
                    items={runItems[segment.runId] ?? NO_ITEMS}
                    running={runs.some((run) => run.id === segment.runId && run.status === "running")}
                    from={segment.from}
                    to={segment.to}
                  />
                </>
              )}
              {summaryRun && <RunSummary run={summaryRun} items={runItems[summaryRun.id] ?? NO_ITEMS} />}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

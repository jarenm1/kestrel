import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { Schema } from "effect"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { DEFAULT_DESKTOP_QUALITY, DESKTOP_QUALITIES, DesktopQuality, type DesktopStatus } from "@cloudagents/protocol"
import { api } from "@/api/client"
import type { DesktopSource } from "@/api/events"
import { keys, queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { RtcPath, RtcStats } from "@/desktop/webrtc"
import { errorText } from "@/util"
import { DesktopScreen } from "./DesktopScreen"
import { StatusIcon } from "./StatusIcon"
import { ThreadGraphs } from "./ThreadGraphs"

/** A viewer nobody can see keeps its stream this long, so switching away and back costs nothing. */
const UNSEEN_GRACE_MS = 5000

const TRANSPORT_LABELS: Readonly<Record<RtcPath, string>> = {
  direct: "WebRTC direct",
  relay: "WebRTC via TURN relay",
}

/** The desktop's stream quality; shared by every viewer, so a pick here changes it for all of them. */
function QualityPicker({
  value,
  disabled,
  onChange,
}: {
  value: DesktopQuality
  disabled: boolean
  onChange: (quality: DesktopQuality) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} className="data-[state=open]:bg-white/[0.06]">
          {DESKTOP_QUALITIES[value].label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Stream quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            if (Schema.is(DesktopQuality)(v)) onChange(v)
          }}
        >
          {DesktopQuality.literals.map((q) => (
            <DropdownMenuRadioItem key={q} value={q}>
              {DESKTOP_QUALITIES[q].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Whether anyone can see the desktop: the tab is visible and the frame is on screen. The stream is wanted while
 * the viewer is seen, and for UNSEEN_GRACE_MS after it stops being seen. Becoming seen again is immediate.
 */
function useStreamWanted(frameRef: RefObject<HTMLDivElement | null>): boolean {
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === "visible")
  const [onScreen, setOnScreen] = useState(true)
  // Starts expired when mounted in a hidden tab, so a background tab never connects.
  const [expired, setExpired] = useState(() => document.visibilityState !== "visible")
  const seen = docVisible && onScreen

  useEffect(() => {
    const onChange = () => setDocVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", onChange)
    return () => document.removeEventListener("visibilitychange", onChange)
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frameRef])

  useEffect(() => {
    if (seen) {
      setExpired(false)
      return
    }
    const timer = window.setTimeout(() => setExpired(true), UNSEEN_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [seen])

  return seen || !expired
}

export function DesktopViewer({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const frameRef = useRef<HTMLDivElement>(null)
  const desktop = useQuery(queries.desktop(taskId))
  const status = desktop.data ?? null
  const [streamError, setStreamError] = useState<string | null>(null)
  const [stats, setStats] = useState<RtcStats | null>(null)
  const wanted = useStreamWanted(frameRef)
  const running = status?.state === "running"
  const active = running || status?.state === "starting"

  // Nobody can see the stream, or there is no desktop to stream: stay disconnected. Each connection is a billed
  // relay request, and the box refuses a stream for a stopped desktop, so connecting anyway would retry every
  // reconnect interval. The thread's event stream moves `status` to "starting" when the desktop comes up.
  const source = useMemo<DesktopSource | null>(() => (wanted && active ? { taskId } : null), [taskId, wanted, active])

  // The state word shown while there is no stream; "loading" and "starting" show the boot bar.
  const idle = running ? (wanted ? null : "paused") : (status?.state ?? "loading")

  const toggle = useMutation({
    mutationFn: async (): Promise<DesktopStatus> => {
      if (!active) return api.startDesktop(taskId)
      await api.stopDesktop(taskId)
      return api.getDesktop(taskId)
    },
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  })
  const setQuality = useMutation({
    mutationFn: (quality: DesktopQuality) => api.setDesktopQuality(taskId, { quality }),
    onSuccess: (next) => queryClient.setQueryData(keys.desktop(taskId), next),
  })

  const actionError = toggle.error ?? setQuality.error ?? desktop.error
  const error = actionError ? errorText(actionError) : (status?.error ?? streamError)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        <Button
          variant={active ? "soft" : "default"}
          size="sm"
          onClick={() => toggle.mutate()}
          disabled={toggle.isPending || !status}
        >
          {active ? "Stop" : "Start"}
        </Button>
        {status && <StatusIcon status={status.state} />}
        <QualityPicker
          value={status?.quality ?? DEFAULT_DESKTOP_QUALITY}
          disabled={!active || setQuality.isPending}
          onChange={(quality) => setQuality.mutate(quality)}
        />
        {status && status.state === "running" && wanted && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {stats?.fps ?? 0} fps · {(stats?.decodeMs ?? 0).toFixed(1)} ms decode ·{" "}
            {stats?.path ? TRANSPORT_LABELS[stats.path] : "WebRTC"}
            {stats?.rttMs != null && <> · {Math.round(stats.rttMs)} ms RTT</>} · {status.display}
          </span>
        )}
      </div>
      {error && <Alert className="mx-3 mb-2 w-auto">{error}</Alert>}
      {/* The stream keeps the largest size that fits the panel; the graphs go under it and scroll when they don't fit.
          The gutter is always reserved, so a scrollbar appearing never shrinks the stream and loops. */}
      <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto [container-type:size] [scrollbar-gutter:stable_both-edges]">
        <DesktopScreen
          source={source}
          status={status}
          idle={idle}
          frameRef={frameRef}
          onStatus={(next) => {
            queryClient.setQueryData(keys.desktop(taskId), next)
            if (next.state === "running") setStreamError(null)
          }}
          onClose={() => setStreamError("Desktop connection lost; reconnecting…")}
          onStats={setStats}
        />
        <ThreadGraphs taskId={taskId} />
      </div>
    </div>
  )
}

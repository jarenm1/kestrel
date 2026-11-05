import { useEffect, useId, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ControlPaths,
  CURRENT_PLAN,
  PLANS,
  connectedModelProviders,
  modelInfo,
  type AgentEffort,
  type AgentModel,
  type BoxList,
  type Plan,
  type TextGenerationSettings as TextGenerationConfig,
  type ThreadSettings as ThreadConfig,
  type Usage,
} from "@cloudagents/protocol"
import { Check, CreditCard, ExternalLink, Layers, LogOut, MessagesSquare, Plug, RotateCcw, Server, User } from "lucide-react"
import { Navigate, NavLink, Outlet } from "react-router-dom"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { ModelPicker, ThinkingPicker, effortOptions } from "@/components/AgentPickers"
import { Boxes } from "@/components/Boxes"
import { Connections } from "@/components/Connections"
import { Fleet } from "@/components/Fleet"
import { Alert } from "@cloudagents/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { SERVER_URL } from "@/config"
import { useShownModels } from "@/hooks/useShownModels"
import { useSignOut } from "@/hooks/useSignOut"
import { cn } from "@/lib/utils"
import { errorText } from "@/util"

const sections = [
  { to: "profile", label: "Profile", icon: User },
  { to: "connections", label: "Connections", icon: Plug },
  { to: "threads", label: "Threads", icon: MessagesSquare },
  { to: "boxes", label: "Boxes", icon: Server },
  { to: "billing", label: "Billing", icon: CreditCard },
] as const

const operatorSections = [{ to: "fleet", label: "Fleet", icon: Layers }] as const

export function SettingsLayout() {
  const me = useQuery(queries.me())
  const navSections = me.data?.operator ? [...sections, ...operatorSections] : sections
  return (
    // Sized by the panel it sits in (beside the threads strip), not the viewport.
    <div className="@container min-h-0 flex-1 overflow-auto">
      {/* The nav column is mirrored by an empty one on the right, so the content sits in the middle of the page. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 @5xl:grid @5xl:max-w-none @5xl:grid-cols-[11rem_minmax(0,48rem)_11rem] @5xl:justify-center @5xl:gap-10">
        <aside className="flex shrink-0 flex-col gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <nav className="flex gap-1 @5xl:flex-col">
            {navSections.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors duration-200 hover:text-foreground",
                    isActive && "bg-white/[0.07] text-foreground",
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col gap-6">
          <Outlet />
        </section>
      </div>
    </div>
  )
}

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground">{desc}</p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  )
}

export function ProfileSettings() {
  const me = useQuery(queries.me())
  const connections = useQuery(queries.connections())
  const signOut = useSignOut()
  if (!me.data) return null
  const { login, name, avatarUrl } = me.data
  const github = connections.data?.find((connection) => connection.provider === "github")

  return (
    <>
      <SectionHeader title="Profile" desc="Your Kestrel account comes from GitHub." />
      <Card className="py-0">
        <CardContent className="flex items-center gap-4 px-5 py-5">
          <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-lg font-medium uppercase shadow-soft">
            {avatarUrl ? <img className="size-full" src={avatarUrl} alt="" /> : login.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{name ?? login}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">@{login}</div>
          </div>
          <Button asChild variant="soft" size="sm" className="ml-auto">
            <a href={`https://github.com/${login}`} target="_blank" rel="noopener noreferrer">
              GitHub profile <ExternalLink />
            </a>
          </Button>
        </CardContent>
      </Card>
      <Card className="py-0">
        <CardContent className="divide-y divide-white/[0.04] px-0">
          <Row label="Name">{name ?? <span className="text-muted-foreground">Not set on GitHub</span>}</Row>
          <Row label="Username">
            <span className="font-mono">{login}</span>
          </Row>
          <Row label="Sign-in">
            <Badge variant="success">GitHub</Badge>
          </Row>
        </CardContent>
      </Card>
      <Card className="py-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">GitHub access</h3>
              {github && (
                <>
                  <Badge variant={github.expired ? "warning" : github.connected ? "success" : "neutral"}>
                    {github.expired ? "expired" : github.connected ? "connected" : "not connected"}
                  </Badge>
                  {github.account && <span className="font-mono text-xs text-muted-foreground">{github.account}</span>}
                </>
              )}
            </div>
            <p className="text-muted-foreground">Let Kestrel work with your GitHub repositories.</p>
            {connections.error && <Alert>{errorText(connections.error)}</Alert>}
            {connections.isPending && <p className="text-muted-foreground">Loading GitHub access…</p>}
            {github && !github.available && (
              <p className="text-muted-foreground">GitHub access needs server configuration.</p>
            )}
          </div>
          {github?.available && (
            <Button asChild variant="soft" className="shrink-0">
              <a href={SERVER_URL + ControlPaths.connectOAuth(github.provider) + "?return=/settings/profile"}>
                {github.connected ? "Reconnect GitHub" : "Connect GitHub"}
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
      <div>
        <Button variant="soft" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </>
  )
}

export function ConnectionsSettings() {
  return (
    <>
      <h2 className="text-lg font-semibold tracking-tight">Connections</h2>
      <Connections />
    </>
  )
}

const STREAMING_OPTIONS = [
  {
    value: "paragraph",
    label: "Show finished paragraphs",
    desc: "Each paragraph or code block appears as soon as it is complete.",
  },
  {
    value: "turn",
    label: "Wait for the full response",
    desc: "Text appears once the agent finishes its turn.",
  },
] as const

const TEXT_GENERATION_DESC =
  "Choose how short generated text is written, how new threads are titled, and how assistant prose is buffered."

/**
 * The active box's route. A box switch remounts the form, so no state from another box can survive it. When Kestrel's
 * box is active (`activeBoxId === null`), `targetBoxId` names the managed box itself so a write can be pinned to it;
 * null stays only for the legacy relay, which has no box id to pin.
 */
function activeBoxRoute(list: BoxList): { key: string; targetBoxId: string | null } {
  const active = list.activeBoxId
  const box =
    active === null || active === list.managedBox?.id
      ? list.managedBox
      : list.boxes.find((candidate) => candidate.id === active)
  return {
    key: JSON.stringify([active, box?.id ?? null, box?.url ?? null]),
    targetBoxId: active ?? box?.id ?? null,
  }
}

export function ThreadsSettings() {
  return (
    <>
      <h2 className="text-lg font-semibold tracking-tight">Threads</h2>
      <section aria-label="Text generation" className="flex min-w-0 flex-col gap-6">
        <TextGenerationSettings />
      </section>
      <section aria-label="Usage limits" className="flex min-w-0 flex-col gap-3">
        <h3 className="font-semibold">Usage limits</h3>
        <UsageLimitSettings />
      </section>
    </>
  )
}

/**
 * Generated-text preferences of the signed-in user on the active box: the model and thinking level used for short
 * generated text, the instructions that shape automatic thread titles, and how assistant prose is buffered.
 */
function TextGenerationSettings() {
  const boxes = useQuery(queries.boxes())
  if (!boxes.data) {
    return (
      <>
        <div>
          <h3 className="font-semibold">Text generation</h3>
          <p className="text-muted-foreground">{TEXT_GENERATION_DESC}</p>
        </div>
        {boxes.error && <Alert>{errorText(boxes.error)}</Alert>}
        {boxes.isPending && <div className="text-muted-foreground">Loading settings…</div>}
      </>
    )
  }
  const route = activeBoxRoute(boxes.data)
  // Keyed by the box route: switching boxes unmounts the old form synchronously; its writes stay pinned to that box.
  return <TextGenerationSettingsForBox key={route.key} boxKey={route.key} boxId={route.targetBoxId} />
}

/**
 * Model, thinking level and streaming save immediately; title instructions save on blur. Writes are queued so one PUT
 * is in flight at a time, and the queue is pinned to the box it was opened for. Unmounting only suppresses form state
 * updates: every accepted change still reaches that box and updates its cache, so navigating away cannot lose a pick.
 */
function TextGenerationSettingsForBox({ boxKey, boxId }: { boxKey: string; boxId: string | null }) {
  const queryClient = useQueryClient()
  const connections = useQuery(queries.connections())
  const settings = useQuery(queries.textGenerationSettings(boxKey, boxId))
  const shown = useShownModels()
  const instructionsId = useId()
  const [form, setForm] = useState<TextGenerationConfig>()
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveError, setSaveError] = useState<unknown>()
  const savedInstructions = useRef("")
  const queued = useRef<TextGenerationConfig | undefined>(undefined)
  const draining = useRef(false)
  const hydrated = useRef(false)
  const disposed = useRef(false)

  // Hydrate once from the snapshot the mount's own GET settled on, never from cached data a fresh GET may still be
  // replacing. After that, later cache changes (including our own successful saves) must not overwrite user edits.
  useEffect(() => {
    if (hydrated.current || settings.data === undefined || !settings.isFetchedAfterMount) return
    hydrated.current = true
    setForm(settings.data)
    savedInstructions.current = settings.data.threadTitleInstructions
  }, [settings.data, settings.isFetchedAfterMount])

  // Navigating away stops form updates but lets the queue keep draining to the box it was captured for.
  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
    }
  }, [])

  useEffect(() => {
    if (saveState !== "saved") return
    const timer = setTimeout(() => setSaveState("idle"), 2000)
    return () => clearTimeout(timer)
  }, [saveState])

  function drainSave() {
    if (draining.current) return
    draining.current = true
    void (async () => {
      try {
        // The queue keeps draining after unmount: its writes are pinned to `boxId`, so leaving the page cannot
        // discard a pick the user already made.
        while (queued.current !== undefined) {
          const next = queued.current
          queued.current = undefined
          if (!disposed.current) {
            setSaveError(undefined)
            setSaveState("saving")
          }
          try {
            const saved = await api.saveTextGenerationSettings(next, boxId)
            // The box accepted this snapshot, so the next visit may start from it even if this view is gone.
            queryClient.setQueryData(keys.textGenerationSettings(boxKey), saved)
            if (!disposed.current) {
              savedInstructions.current = next.threadTitleInstructions
              setSaveState(queued.current === undefined ? "saved" : "saving")
            }
          } catch (error) {
            if (!disposed.current) {
              setSaveError(error)
              setSaveState("error")
            }
          }
        }
      } finally {
        draining.current = false
        if (queued.current !== undefined) drainSave()
      }
    })()
  }

  function persist(next: TextGenerationConfig) {
    if (!disposed.current) setForm(next)
    queued.current = next
    drainSave()
  }

  if (!form) {
    return (
      <>
        <div>
          <h3 className="font-semibold">Text generation</h3>
          <p className="text-muted-foreground">{TEXT_GENERATION_DESC}</p>
        </div>
        {settings.error && <Alert>{errorText(settings.error)}</Alert>}
        {(settings.isPending || settings.isFetching) && (
          <div className="text-muted-foreground">Loading settings…</div>
        )}
      </>
    )
  }

  const connected = connections.data ? connectedModelProviders(connections.data) : []
  const modelSections = connections.data
    ? connected.map((provider) => ({ provider, models: shown[provider.id] })).filter((section) => section.models.length > 0)
    : null
  const model = form.model === null ? undefined : modelInfo(form.model)
  const effort = form.effort ?? model?.defaultEffort ?? model?.efforts[0]

  function update(patch: Partial<TextGenerationConfig>) {
    if (!form) return
    persist({ ...form, ...patch })
  }

  function saveInstructions() {
    if (!form) return
    const value = form.threadTitleInstructions.trim()
    if (value !== savedInstructions.current) persist({ ...form, threadTitleInstructions: value })
  }

  return (
    <>
      <div>
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold">Text generation</h3>
          <Switch
            aria-label="Enable text generation"
            checked={form.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </div>
        <p className="text-muted-foreground">
          {form.enabled
            ? TEXT_GENERATION_DESC
            : "Off. Keep original prompt-based titles and token-by-token responses, without extra title-generation requests."}
        </p>
      </div>
      {settings.error && <Alert>{errorText(settings.error)}</Alert>}
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      <fieldset
        aria-label="Text generation settings"
        disabled={!form.enabled}
        inert={!form.enabled}
        className="flex min-w-0 flex-col gap-6 border-0 p-0 transition-opacity disabled:opacity-40"
      >
        <Card className="py-0">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <span className="text-muted-foreground">Model</span>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
              <ModelPicker
                sections={modelSections}
                value={model}
                onChange={(id: AgentModel) => {
                  const next = modelInfo(id)
                  update({
                    model: id,
                    effort: form.effort !== null && next.efforts.includes(form.effort) ? form.effort : null,
                  })
                }}
                defaultLabel="Conversation model"
              />
              {model !== undefined && model.efforts.length > 0 && (
                <ThinkingPicker
                  value={effort}
                  options={effortOptions(model)}
                  onChange={(level: AgentEffort) => update({ effort: level })}
                />
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardContent className="flex flex-col gap-2 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={instructionsId} className="font-medium">
                Thread title instructions
              </label>
              {form.threadTitleInstructions !== "" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => persist({ ...form, threadTitleInstructions: "" })}
                >
                  <RotateCcw />
                  Reset
                </Button>
              )}
            </div>
            <Textarea
              id={instructionsId}
              rows={3}
              value={form.threadTitleInstructions}
              placeholder="Keep titles to a few words. Lead with the main subject."
              onChange={(event) => setForm({ ...form, threadTitleInstructions: event.target.value })}
              onBlur={saveInstructions}
            />
            <p className="text-xs text-muted-foreground">
              Added to Kestrel's prompt when it automatically names a new thread. Leave blank to use the default
              instructions. Changes save when you leave the field.
            </p>
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardContent className="px-5 py-4">
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="font-medium">Response streaming</h3>
                <p className="text-xs text-muted-foreground">
                  How assistant prose is buffered before it reaches the transcript.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {STREAMING_OPTIONS.map((option) => {
                  const active = form.responseStreamingMode === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => update({ responseStreamingMode: option.value })}
                      className={cn(
                        "rounded-xl border px-4 py-3 text-left transition-colors duration-200",
                        active
                          ? "border-primary/40 bg-white/[0.06] shadow-soft"
                          : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2 text-sm font-medium">
                        {option.label}
                        {active && <Check className="size-4 text-primary" />}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">{option.desc}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      {saveState === "error" && <Alert>{errorText(saveError)}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground" role="status">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
        </span>
      </div>
    </>
  )
}

/**
 * The active box's preferences for how threads run. Reads and writes are pinned to the box the form was opened for,
 * like text generation: switching boxes remounts the form.
 */
function UsageLimitSettings() {
  const boxes = useQuery(queries.boxes())
  if (!boxes.data) {
    return (
      <>
        {boxes.error && <Alert>{errorText(boxes.error)}</Alert>}
        {boxes.isPending && <div className="text-muted-foreground">Loading settings…</div>}
      </>
    )
  }
  const route = activeBoxRoute(boxes.data)
  return <UsageLimitSettingsForBox key={route.key} boxKey={route.key} boxId={route.targetBoxId} />
}

function UsageLimitSettingsForBox({ boxKey, boxId }: { boxKey: string; boxId: string | null }) {
  const queryClient = useQueryClient()
  const settings = useQuery(queries.threadSettings(boxKey, boxId))
  const save = useMutation({
    mutationFn: (next: ThreadConfig) => api.saveThreadSettings(next, boxId),
    onMutate: async (next) => {
      const key = keys.threadSettings(boxKey)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ThreadConfig>(key)
      queryClient.setQueryData(key, next)
      return { previous }
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(keys.threadSettings(boxKey), context.previous)
      }
    },
    onSuccess: (saved) => queryClient.setQueryData(keys.threadSettings(boxKey), saved),
  })
  const enabled = settings.data?.autoResumeAfterUsageLimits ?? false

  return (
    <>
      <Card className="py-0">
        <CardContent className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="font-medium">Resume after usage limits</div>
            <p className="text-xs text-muted-foreground">
              Automatically resume threads when their usage limits reset. You can cancel auto-resume in each thread.
            </p>
          </div>
          <Switch
            aria-label="Resume after usage limits"
            checked={enabled}
            disabled={settings.data === undefined || save.isPending}
            onCheckedChange={(next) => {
              if (settings.data !== undefined) save.mutate({ ...settings.data, autoResumeAfterUsageLimits: next })
            }}
          />
        </CardContent>
      </Card>
      {settings.error && <Alert>{errorText(settings.error)}</Alert>}
      {save.error && <Alert>{errorText(save.error)}</Alert>}
    </>
  )
}

export function BoxesSettings() {
  return (
    <>
      <SectionHeader title="Boxes" desc="Where your threads run: Kestrel's box, or your own machine reached directly." />
      <Boxes />
    </>
  )
}

export function FleetSettings() {
  const me = useQuery(queries.me())
  if (me.data && !me.data.operator) return <Navigate to="/settings/profile" replace />
  return (
    <>
      <SectionHeader
        title="Fleet"
        desc="Kestrel's managed boxes. Each serves many users; a new user is assigned to the active box with the fewest."
      />
      <Fleet />
    </>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

function hours(seconds: number): string {
  const h = seconds / 3600
  if (h > 0 && h < 0.1) return "<0.1"
  return h < 10 ? h.toFixed(1) : Math.round(h).toString()
}

export function BillingSettings() {
  const usage = useQuery(queries.usage())
  const current = PLANS.find((p) => p.id === CURRENT_PLAN)!

  return (
    <>
      <SectionHeader title="Billing" desc="Your plan and this month's agent usage." />
      <Card className="gap-0 py-0 shadow-glow">
        <CardContent className="flex flex-wrap items-start gap-4 px-5 py-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs tracking-wider text-muted-foreground uppercase">Current plan</span>
              <Badge variant="success">active</Badge>
            </div>
            <div className="text-2xl font-semibold tracking-tight">{current.name}</div>
            <p className="text-muted-foreground">{current.desc}</p>
          </div>
          <div className="ml-auto flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">{current.price}</span>
            <span className="text-sm text-muted-foreground">{current.period}</span>
          </div>
        </CardContent>
        <div className="border-t border-white/[0.04] px-5 py-5">
          {usage.error && <Alert>{errorText(usage.error)}</Alert>}
          {usage.isPending && <div className="text-muted-foreground">Loading usage…</div>}
          {usage.data && <UsageSummary usage={usage.data} plan={current} />}
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        <SectionHeader title="Plans" desc="Paid plans open when billing goes live; everyone is on Hobby for now." />
        <div className="grid gap-4 md:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} current={plan.id === CURRENT_PLAN} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionHeader title="Payment and invoices" desc="Cards and receipts for paid plans." />
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            <Row label="Payment method">
              <span className="text-muted-foreground">None. The Hobby plan needs no card.</span>
            </Row>
            <Row label="Invoices">
              <span className="text-muted-foreground">No invoices yet.</span>
            </Row>
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function UsageSummary({ usage, plan }: { usage: Usage; plan: Plan }) {
  const usedHours = usage.agentSeconds / 3600
  const share = plan.agentHours === null ? 0 : Math.min(1, usedHours / plan.agentHours)
  const lastDay = new Date(Date.parse(usage.periodEnd) - 1)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">Agent hours</span>
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground">{hours(usage.agentSeconds)}</span>
            {plan.agentHours === null ? " used" : ` of ${plan.agentHours} h`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Agent hours used"
          aria-valuenow={Math.round(share * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 overflow-hidden rounded-full bg-white/[0.06]"
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", share >= 1 ? "bg-warning" : "bg-primary")}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {dateFormat.format(new Date(usage.periodStart))} – {dateFormat.format(lastDay)} (UTC). Resets on{" "}
          {dateFormat.format(new Date(usage.periodEnd))}.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Agent runs" value={usage.runs} />
        <Stat label="Threads with runs" value={usage.threads} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white/[0.03] px-4 py-3">
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PlanCard({ plan, current }: { plan: Plan; current: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl p-5 transition-[background-color,box-shadow] duration-300",
        current ? "bg-card shadow-glow" : "bg-card/60 shadow-soft hover:bg-card hover:shadow-glow",
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-semibold">{plan.name}</h3>
        {current && <Badge variant="info">current</Badge>}
      </div>
      <div className="mb-4 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight">{plan.price}</span>
        <span className="text-xs text-muted-foreground">{plan.period}</span>
      </div>
      <ul className="mb-5 flex-1 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-foreground/85">
            <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {feature}
          </li>
        ))}
      </ul>
      <Button variant={current ? "soft" : "default"} size="sm" disabled className="w-full">
        {current ? "Your plan" : "Coming soon"}
      </Button>
    </div>
  )
}

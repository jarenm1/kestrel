import { Fragment, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { Schema } from "effect"
import {
  GithubAutomationEvent,
  AgentModel,
  connectedModelProviders,
  modelInfo,
  type Automation,
  type AutomationTrigger,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { KESTREL_BOX } from "@/components/BoxPicker"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useShownModels } from "@/hooks/useShownModels"
import { DELIVERY_LABELS, EVENT_LABELS, formatNextRun, ON_UNAVAILABLE_LABELS, splitList } from "@/lib/automations"
import { errorText } from "@/util"

const TIMEZONES = Intl.supportedValuesOf("timeZone")

/**
 * Edits an automation's name, prompt, model and trigger settings. The trigger kind (schedule or GitHub) stays as it is;
 * the server validates the rest and its messages (e.g. a bad cron) show inline.
 */
export function AutomationEditDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  return (
    <Dialog
      open={automation !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        {automation && <AutomationEditForm key={automation.id} automation={automation} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function AutomationEditForm({ automation, onDone }: { automation: Automation; onDone: () => void }) {
  const queryClient = useQueryClient()
  const connections = useQuery(queries.connections())
  const shown = useShownModels()
  const providers = connectedModelProviders(connections.data ?? [])
  const [model, setModel] = useState<AgentModel | null>(automation.model)
  const selected = model === null ? null : modelInfo(model)
  const selectionListed = selected !== null && providers.some(
    (provider) => shown[provider.id].some((candidate) => candidate.id === selected.id),
  )
  const trigger = automation.trigger
  const [name, setName] = useState(automation.name)
  const [prompt, setPrompt] = useState(automation.prompt)
  const [cron, setCron] = useState(trigger._tag === "schedule" ? trigger.cron : "")
  const [timezone, setTimezone] = useState(trigger._tag === "schedule" ? trigger.timezone : "")
  const [events, setEvents] = useState<readonly GithubAutomationEvent[]>(
    trigger._tag === "github" ? trigger.events : [],
  )
  const [reviewers, setReviewers] = useState(trigger._tag === "github" ? (trigger.reviewers ?? []).join(", ") : "")
  const [baseBranches, setBaseBranches] = useState(
    trigger._tag === "github" ? (trigger.baseBranches ?? []).join(", ") : "",
  )
  const [includeDrafts, setIncludeDrafts] = useState(trigger._tag === "github" && trigger.includeDrafts === true)
  const [preferredBoxId, setPreferredBoxId] = useState<string | null>(automation.webhook?.preferredBoxId ?? null)
  const [onUnavailable, setOnUnavailable] = useState<WebhookEndpoint["onUnavailable"]>(
    automation.webhook?.onUnavailable ?? "retry",
  )

  const save = useMutation({
    mutationFn: () =>
      api.updateAutomation(automation.id, {
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        trigger: buildTrigger(),
        ...(trigger._tag === "webhook" ? { webhook: { preferredBoxId, onUnavailable } } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.automations })
      onDone()
    },
  })

  /** Throws (shown as the save error) when a GitHub automation has no event picked. */
  function buildTrigger(): AutomationTrigger {
    if (trigger._tag === "schedule") return { _tag: "schedule", cron: cron.trim(), timezone: timezone.trim() }
    if (trigger._tag === "webhook") return { _tag: "webhook" }
    const [first, ...rest] = events
    if (first === undefined) throw new Error("Pick at least one pull request event.")
    return {
      _tag: "github",
      events: [first, ...rest],
      reviewers: splitList(reviewers),
      baseBranches: splitList(baseBranches),
      includeDrafts,
    }
  }

  const canSave =
    name.trim() !== "" &&
    prompt.trim() !== "" &&
    (trigger._tag === "schedule"
      ? cron.trim() !== "" && timezone.trim() !== ""
      : trigger._tag === "github"
        ? events.length > 0
        : true)

  return (
    <>
      <DialogTitle>Edit automation</DialogTitle>
      <DialogDescription>
        {trigger._tag === "schedule"
          ? "Runs on a schedule."
          : trigger._tag === "github"
            ? "Runs on pull request events."
            : "Runs when a request arrives at its webhook."}
      </DialogDescription>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) save.mutate()
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Prompt">
          <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <Field label="Model">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="secondary" className="justify-between">
                {selected?.name ?? "Default (box model)"}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-(--radix-dropdown-menu-content-available-height) min-w-56 overflow-y-auto">
              <DropdownMenuRadioGroup
                value={model ?? ""}
                onValueChange={(value) => {
                  if (value === "") setModel(null)
                  else if (Schema.is(AgentModel)(value)) setModel(value)
                }}
              >
                <DropdownMenuRadioItem value="">Default (box model)</DropdownMenuRadioItem>
                {selected !== null && !selectionListed && (
                  <DropdownMenuRadioItem value={selected.id}>{selected.name} (saved)</DropdownMenuRadioItem>
                )}
                {providers.map((provider) => (
                  <Fragment key={provider.id}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{provider.name}</DropdownMenuLabel>
                    {shown[provider.id].map((candidate) => (
                      <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuRadioGroup>
              {connections.isPending && <DropdownMenuLabel>Loading models…</DropdownMenuLabel>}
              {connections.error && <DropdownMenuLabel>Could not load connected models.</DropdownMenuLabel>}
              {connections.isSuccess && providers.length === 0 && (
                <DropdownMenuLabel>Connect Anthropic or OpenAI to choose a model.</DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>

        {trigger._tag === "schedule" ? (
          <>
            <Field label="Cron (minute hour day-of-month month day-of-week)">
              <Input
                className="font-mono"
                value={cron}
                placeholder="0 9 * * 1-5"
                onChange={(e) => setCron(e.target.value)}
              />
            </Field>
            <Field label="Timezone">
              <Input
                list="automation-timezones"
                value={timezone}
                placeholder="America/New_York"
                onChange={(e) => setTimezone(e.target.value)}
              />
              <datalist id="automation-timezones">
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
          </>
        ) : trigger._tag === "github" ? (
          <>
            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-1 text-xs text-muted-foreground">Pull request events</legend>
              {GithubAutomationEvent.literals.map((event) => (
                <label key={event} className="flex items-center gap-2.5">
                  <Checkbox
                    checked={events.includes(event)}
                    onCheckedChange={(checked) =>
                      setEvents(GithubAutomationEvent.literals.filter((e) => (e === event ? checked === true : events.includes(e))))
                    }
                  />
                  {EVENT_LABELS[event]}
                </label>
              ))}
            </fieldset>
            <Field label="Reviewers (comma-separated; empty means any)">
              <Input value={reviewers} placeholder="alice, bob" onChange={(e) => setReviewers(e.target.value)} />
            </Field>
            <Field label="Base branches (comma-separated; empty means any)">
              <Input value={baseBranches} placeholder="main" onChange={(e) => setBaseBranches(e.target.value)} />
            </Field>
            <label className="flex items-center justify-between gap-3">
              Include draft pull requests
              <Switch checked={includeDrafts} onCheckedChange={setIncludeDrafts} />
            </label>
          </>
        ) : (
          <>
        <WebhookBoxFields
          preferredBoxId={preferredBoxId}
          onUnavailable={onUnavailable}
          onPreferredBoxIdChange={setPreferredBoxId}
          onUnavailableChange={setOnUnavailable}
        />
            {automation.webhook && <WebhookSection automationId={automation.id} url={automation.webhook.url} />}
          </>
        )}

        {save.error && <Alert>{errorText(save.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** Box to run a webhook on and what happens when that box is unavailable. Shared by the create and edit forms. */
export function WebhookBoxFields({
  preferredBoxId,
  onUnavailable,
  onPreferredBoxIdChange,
  onUnavailableChange,
}: {
  preferredBoxId: string | null
  onUnavailable: WebhookEndpoint["onUnavailable"]
  onPreferredBoxIdChange: (boxId: string | null) => void
  onUnavailableChange: (policy: WebhookEndpoint["onUnavailable"]) => void
}) {
  const boxes = useQuery(queries.boxes())
  return (
    <>
      <Field label="Box to run on">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" className="justify-between">
              {preferredBoxId === null
                ? "Kestrel's box"
                : (boxes.data?.boxes.find((box) => box.id === preferredBoxId)?.name ??
                  (boxes.isPending ? "Loading…" : "Unavailable box"))}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuRadioGroup
              value={preferredBoxId ?? KESTREL_BOX}
              onValueChange={(value) => onPreferredBoxIdChange(value === KESTREL_BOX ? null : value)}
            >
              <DropdownMenuRadioItem value={KESTREL_BOX}>Kestrel's box</DropdownMenuRadioItem>
              {boxes.data?.boxes.map((box) => (
                <DropdownMenuRadioItem key={box.id} value={box.id}>
                  {box.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {boxes.isPending && <DropdownMenuLabel>Loading your boxes…</DropdownMenuLabel>}
            {boxes.error && <DropdownMenuLabel>Could not load your boxes.</DropdownMenuLabel>}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>
      <Field label="When that box is unavailable">
        <div className="flex gap-2">
          <Button
            type="button"
            variant={onUnavailable === "retry" ? "secondary" : "ghost"}
            aria-pressed={onUnavailable === "retry"}
            onClick={() => onUnavailableChange("retry")}
          >
            {ON_UNAVAILABLE_LABELS.retry}
          </Button>
          <Button
            type="button"
            variant={onUnavailable === "fail" ? "secondary" : "ghost"}
            aria-pressed={onUnavailable === "fail"}
            onClick={() => onUnavailableChange("fail")}
          >
            {ON_UNAVAILABLE_LABELS.fail}
          </Button>
        </div>
      </Field>
      <p className="text-xs text-muted-foreground">
        Deliveries stay on the box you pick. Using another box as a fallback is not available yet.
      </p>
    </>
  )
}

function deliveryVariant(status: WebhookDelivery["status"]): "success" | "warning" | "destructive" | "info" {
  if (status === "delivered") return "success"
  if (status === "failed" || status === "expired") return "destructive"
  if (status === "ambiguous" || status === "retrying") return "warning"
  return "info"
}

/** Stable sender URL and secret rotation (shown once), plus recent deliveries while the editor is open. */
function WebhookSection({ automationId, url }: { automationId: string; url: string }) {
  const deliveries = useQuery(queries.automationDeliveries(automationId))
  const [secret, setSecret] = useState<string | null>(null)
  const rotate = useMutation({
    mutationFn: () => api.rotateAutomationWebhook(automationId),
    onSuccess: (rotated) => setSecret(rotated.secret),
  })

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-3">
      <Field label="Webhook URL">
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono" />
          <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(url)}>
            Copy
          </Button>
        </div>
      </Field>

      {secret === null ? (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          disabled={rotate.isPending}
          onClick={() => {
            if (window.confirm("Rotate the webhook secret? The current secret stops working immediately.")) {
              rotate.mutate()
            }
          }}
        >
          {rotate.isPending ? "Rotating…" : "Rotate secret"}
        </Button>
      ) : (
        <Field label="New secret (shown once)">
          <div className="flex gap-2">
            <Input readOnly value={secret} className="font-mono" />
            <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(secret)}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send it as Authorization: Bearer, or sign the body with HMAC-SHA256 and send X-Kestrel-Signature:
            sha256=… . It is not shown again after you leave this screen.
          </p>
          <Button type="button" variant="ghost" className="self-start" onClick={() => setSecret(null)}>
            Done
          </Button>
        </Field>
      )}
      {rotate.error && <Alert>{errorText(rotate.error)}</Alert>}

      <Field label="Recent deliveries">
        {deliveries.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {deliveries.error && <Alert>{errorText(deliveries.error)}</Alert>}
        {deliveries.data?.length === 0 && <p className="text-sm text-muted-foreground">No deliveries yet.</p>}
        {deliveries.data && deliveries.data.length > 0 && (
          <ul className="flex flex-col divide-y divide-white/[0.04]">
            {deliveries.data.map((delivery) => (
              <li key={delivery.id} className="flex flex-col gap-1 py-2">
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={deliveryVariant(delivery.status)}>{DELIVERY_LABELS[delivery.status]}</Badge>
                  <span className="text-xs text-muted-foreground">{formatNextRun(delivery.receivedAt)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{delivery.reason}</p>
                {delivery.error && <p className="text-xs text-destructive">{delivery.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Field>
    </div>
  )
}

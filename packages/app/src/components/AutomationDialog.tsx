import { Fragment, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { Schema } from "effect"
import {
  GithubAutomationEvent,
  AgentModel,
  modelInfo,
  type Automation,
  type AutomationTrigger,
  type CreateAutomationBody,
} from "@cloudagents/protocol"
import { modelDisplayName, offeredModelSections } from "@cloudagents/composer/models"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { harnessById } from "@/lib/harnesses"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
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
import { EVENT_LABELS, splitList } from "@/lib/automations"
import { errorText } from "@/util"

const TIMEZONES = Intl.supportedValuesOf("timeZone")

export type AutomationDialogTarget =
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly automation: Automation }

type TriggerKind = AutomationTrigger["_tag"]

/**
 * Creates an automation, or edits one's name, prompt, model and trigger settings. Editing keeps the trigger kind and
 * repository; creating also picks them together with the enabled state. The server validates everything and its
 * messages (e.g. a bad cron) show inline.
 */
export function AutomationDialog({ target, onClose }: { target: AutomationDialogTarget | null; onClose: () => void }) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        {target && (
          <AutomationForm key={target.kind === "edit" ? target.automation.id : "create"} target={target} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function AutomationForm({ target, onDone }: { target: AutomationDialogTarget; onDone: () => void }) {
  const queryClient = useQueryClient()
  const seed = target.kind === "edit" ? target.automation : null
  const seedTrigger = seed?.trigger
  const connections = useQuery(queries.connections())
  const capabilities = useQuery(queries.capabilities())
  const shown = useShownModels()
  const sections = connections.data
    ? offeredModelSections(connections.data, shown, capabilities.data?.modelHarnesses)
    : null
  const [model, setModel] = useState<AgentModel | null>(seed?.model ?? null)
  const selected = model === null ? null : modelInfo(model)
  const selectionListed =
    selected !== null &&
    sections?.some((section) => section.models.some((candidate) => candidate.id === selected.id)) === true
  const [name, setName] = useState(seed?.name ?? "")
  const [prompt, setPrompt] = useState(seed?.prompt ?? "")
  const [kind, setKind] = useState<TriggerKind>(seedTrigger?._tag ?? "schedule")
  const [cron, setCron] = useState(seedTrigger?._tag === "schedule" ? seedTrigger.cron : "")
  const [timezone, setTimezone] = useState(seedTrigger?._tag === "schedule" ? seedTrigger.timezone : "")
  const [events, setEvents] = useState<readonly GithubAutomationEvent[]>(
    seedTrigger?._tag === "github" ? seedTrigger.events : [],
  )
  const [reviewers, setReviewers] = useState(seedTrigger?._tag === "github" ? (seedTrigger.reviewers ?? []).join(", ") : "")
  const [baseBranches, setBaseBranches] = useState(
    seedTrigger?._tag === "github" ? (seedTrigger.baseBranches ?? []).join(", ") : "",
  )
  const [includeDrafts, setIncludeDrafts] = useState(seedTrigger?._tag === "github" && seedTrigger.includeDrafts === true)
  const [repo, setRepo] = useState<string | null>(seed?.repo ?? null)
  const [enabled, setEnabled] = useState(true)
  const repos = useQuery({ ...queries.githubRepos(), enabled: target.kind === "create" })

  /** Throws (shown as the save error) when a GitHub automation has no event picked. */
  function buildTrigger(): AutomationTrigger {
    if (kind === "schedule") return { _tag: "schedule", cron: cron.trim(), timezone: timezone.trim() }
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

  const save = useMutation({
    mutationFn: (): Promise<Automation> => {
      if (target.kind === "edit") {
        return api.updateAutomation(target.automation.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          model,
          trigger: buildTrigger(),
        })
      }
      const body: CreateAutomationBody = {
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        trigger: buildTrigger(),
        enabled,
        ...(repo === null ? {} : { repo }),
      }
      return api.createAutomation(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.automations })
      onDone()
    },
  })

  const repoRequired = target.kind === "create" && kind === "github"
  const triggerReady = kind === "schedule" ? cron.trim() !== "" && timezone.trim() !== "" : events.length > 0
  const canSave = name.trim() !== "" && prompt.trim() !== "" && triggerReady && (!repoRequired || repo !== null)

  return (
    <>
      <DialogTitle>{target.kind === "edit" ? "Edit automation" : "New automation"}</DialogTitle>
      <DialogDescription>
        {kind === "schedule" ? "Runs on a schedule." : "Runs on pull request events."}
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
                {selected === null ? "Default (box model)" : modelDisplayName(selected)}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              <DropdownMenuRadioGroup
                value={model ?? ""}
                onValueChange={(value) => {
                  if (value === "") setModel(null)
                  else if (Schema.is(AgentModel)(value)) setModel(value)
                }}
              >
                <DropdownMenuRadioItem value="">Default (box model)</DropdownMenuRadioItem>
                {selected !== null && !selectionListed && (
                  <DropdownMenuRadioItem value={selected.id}>{modelDisplayName(selected)} (saved)</DropdownMenuRadioItem>
                )}
                {sections?.map((section) => (
                  <Fragment key={`${section.harness}:${section.provider.id}`}>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      {harnessById(section.harness).name} · {section.provider.name}
                    </DropdownMenuLabel>
                    {section.models.map((candidate) => (
                      <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
                        {modelDisplayName(candidate)}
                      </DropdownMenuRadioItem>
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuRadioGroup>
              {connections.isPending && <DropdownMenuLabel>Loading models…</DropdownMenuLabel>}
              {connections.error && <DropdownMenuLabel>Could not load connected models.</DropdownMenuLabel>}
              {connections.isSuccess && sections !== null && sections.length === 0 && (
                <DropdownMenuLabel>Connect Anthropic or OpenAI to choose a model.</DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>

        {target.kind === "create" && (
          <div className="flex flex-col gap-1.5" role="group" aria-labelledby="automation-trigger">
            <span id="automation-trigger" className="text-xs text-muted-foreground">
              Trigger
            </span>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={kind === "schedule" ? "secondary" : "ghost"}
                aria-pressed={kind === "schedule"}
                onClick={() => setKind("schedule")}
              >
                Schedule
              </Button>
              <Button
                type="button"
                variant={kind === "github" ? "secondary" : "ghost"}
                aria-pressed={kind === "github"}
                onClick={() => setKind("github")}
              >
                Pull requests
              </Button>
            </div>
          </div>
        )}

        <Field label="Repository">
          {target.kind === "edit" ? (
            <span className="font-mono text-xs text-muted-foreground">{target.automation.repo ?? "No repository"}</span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="secondary" className="justify-between">
                  {repo ?? (kind === "schedule" ? "No repository" : "Select a repository")}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={repo ?? ""}
                  onValueChange={(value) => setRepo(value === "" ? null : value)}
                >
                  <DropdownMenuRadioItem value="">No repository</DropdownMenuRadioItem>
                  {repos.data?.map((candidate) => (
                    <DropdownMenuRadioItem key={candidate.fullName} value={candidate.fullName}>
                      {candidate.fullName}
                      {candidate.private ? " (private)" : ""}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {repos.isPending && <DropdownMenuLabel>Loading repositories…</DropdownMenuLabel>}
                {repos.error && <DropdownMenuLabel>Could not load repositories. Connect GitHub to choose one.</DropdownMenuLabel>}
                {repos.isSuccess && repos.data.length === 0 && (
                  <DropdownMenuLabel>No repositories found.</DropdownMenuLabel>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Field>

        {kind === "schedule" ? (
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
        ) : (
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
        )}

        {target.kind === "create" && (
          <label className="flex items-center justify-between gap-3">
            Enabled
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

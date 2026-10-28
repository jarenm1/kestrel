import { useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  GithubAutomationEvent,
  type Automation,
  type AutomationTrigger,
} from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { EVENT_LABELS, splitList } from "@/lib/automations"
import { errorText } from "@/util"

const TIMEZONES = Intl.supportedValuesOf("timeZone")

/**
 * Edits an automation's name, prompt and trigger settings. The trigger kind (schedule or GitHub) stays as it is;
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

  const save = useMutation({
    mutationFn: () =>
      api.updateAutomation(automation.id, { name: name.trim(), prompt: prompt.trim(), trigger: buildTrigger() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.automations })
      onDone()
    },
  })

  /** Throws (shown as the save error) when a GitHub automation has no event picked. */
  function buildTrigger(): AutomationTrigger {
    if (trigger._tag === "schedule") return { _tag: "schedule", cron: cron.trim(), timezone: timezone.trim() }
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
    (trigger._tag === "schedule" ? cron.trim() !== "" && timezone.trim() !== "" : events.length > 0)

  return (
    <>
      <DialogTitle>Edit automation</DialogTitle>
      <DialogDescription>
        {trigger._tag === "schedule" ? "Runs on a schedule." : "Runs on pull request events."}
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

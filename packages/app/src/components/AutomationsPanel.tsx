import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Automation } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { AutomationEditDialog } from "@/components/AutomationEditDialog"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { describeTrigger, formatNextRun, promptPreview } from "@/lib/automations"
import { errorText } from "@/util"

/** Automations for one project. The agent creates them from chat; this view lists, toggles, edits and removes them. */
export function AutomationsPanel({ repoId, repoName }: { repoId: string; repoName: string | undefined }) {
  const queryClient = useQueryClient()
  const automations = useQuery(queries.automations())
  const [editing, setEditing] = useState<Automation | null>(null)

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateAutomation(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.automations }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAutomation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.automations }),
  })

  const projectAutomations = (automations.data ?? []).filter((a) => a.repoId === repoId)
  const error = automations.error ?? toggle.error ?? remove.error

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Automations</h1>
        <p className="text-muted-foreground">
          Tasks the agent starts on a schedule or when a pull request changes
          {repoName ? ` in ${repoName}` : ""}.
        </p>
      </div>

      {error && <Alert>{errorText(error)}</Alert>}
      {automations.isPending && <p className="text-muted-foreground">Loading…</p>}

      {automations.data && projectAutomations.length === 0 && (
        <Card>
          <CardContent className="items-center gap-2 py-10 text-center text-muted-foreground">
            <p className="font-medium text-foreground">No automations for this project yet.</p>
            <p>
              Ask the agent in a thread to set one up, for example “review open pull requests every weekday at 9am”, and
              it will appear here.
            </p>
          </CardContent>
        </Card>
      )}

      {projectAutomations.length > 0 && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            {projectAutomations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                toggling={toggle.isPending && toggle.variables?.id === automation.id}
                removing={remove.isPending && remove.variables === automation.id}
                onEdit={() => setEditing(automation)}
                onToggle={(enabled) => toggle.mutate({ id: automation.id, enabled })}
                onRemove={() => remove.mutate(automation.id)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <AutomationEditDialog automation={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function AutomationRow({
  automation,
  toggling,
  removing,
  onEdit,
  onToggle,
  onRemove,
}: {
  automation: Automation
  toggling: boolean
  removing: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{automation.name}</span>
            <Badge variant={automation.enabled ? "success" : "neutral"}>
              {automation.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{describeTrigger(automation.trigger, automation.repo)}</span>
        </div>
        <Switch
          aria-label={`Enabled: ${automation.name}`}
          checked={automation.enabled}
          disabled={toggling}
          onCheckedChange={onToggle}
        />
      </div>

      <p className="line-clamp-2 text-sm text-muted-foreground">{promptPreview(automation.prompt)}</p>

      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {automation.nextRunAt !== null && <span>Next run {formatNextRun(automation.nextRunAt)}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          {confirming ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" disabled={removing} onClick={onRemove}>
                {removing ? "Removing…" : "Confirm remove"}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

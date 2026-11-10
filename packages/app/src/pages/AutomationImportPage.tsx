import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { modelInfo, type AutomationShare } from "@cloudagents/protocol"
import { modelDisplayName } from "@cloudagents/composer/models"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { RepoPicker } from "@/components/RepoPicker"
import { AUTOMATION_SHARE_PARAM, parseAutomationShare } from "@/lib/automationShare"
import { describeTrigger } from "@/lib/automations"
import { errorText } from "@/util"

/** Landing page for a shared automation link. Unknown or edited links never offer an import. */
export function AutomationImportPage() {
  const [params] = useSearchParams()
  const shared = parseAutomationShare(params.get(AUTOMATION_SHARE_PARAM))

  if (shared === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        <h1 className="text-xl font-semibold tracking-tight">Import automation</h1>
        <Alert>This automation link is invalid or incomplete. Ask the sender for a new link.</Alert>
        <Button asChild variant="secondary" className="self-start">
          <Link to="/settings/automations">Back to automations</Link>
        </Button>
      </div>
    )
  }

  return <AutomationImportForm shared={shared} />
}

function AutomationImportForm({ shared }: { shared: AutomationShare }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const repos = useQuery(queries.githubRepos())
  const [name, setName] = useState(shared.name)
  const [repo, setRepo] = useState<string | undefined>(shared.repo ?? undefined)

  const sharedRepo = shared.repo
  // GitHub's repository list is one page sorted by update time, so ask about the shared repository directly.
  const repoAccess = useQuery({
    ...queries.githubRepo(sharedRepo ?? ""),
    enabled: sharedRepo !== null,
  })
  // The sender's repository is only a default: if the recipient cannot access it, never create with it.
  const sharedRepoUnavailable = sharedRepo !== null && repoAccess.isError
  useEffect(() => {
    if (sharedRepoUnavailable && repo === sharedRepo) setRepo(undefined)
  }, [repo, sharedRepo, sharedRepoUnavailable])

  const create = useMutation({
    mutationFn: () =>
      api.createAutomation({
        name: name.trim(),
        prompt: shared.prompt,
        model: shared.model,
        trigger: shared.trigger,
        enabled: false,
        ...(repo === undefined ? {} : { repo }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.automations })
      navigate("/settings/automations")
    },
  })

  const repoCheckPending = sharedRepo !== null && repoAccess.isPending
  const repoRequired = shared.trigger._tag === "github"
  const canImport =
    name.trim() !== "" && !repoCheckPending && (!repoRequired || repo !== undefined)
  const model = shared.model === null ? null : modelInfo(shared.model)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Import automation</h1>
        <p className="text-muted-foreground">
          A Kestrel user shared “{shared.name}”. Importing creates a disabled copy of your own; the sharer’s runs and
          history stay with them.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardContent className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="flex flex-col items-start gap-1.5">
            <span className="text-xs text-muted-foreground">Repository</span>
            <RepoPicker
              value={repo}
              onChange={setRepo}
              disabled={repos.isPending}
              extraRepo={repoAccess.data}
            />
            <span className="text-xs text-muted-foreground">
              {repoRequired
                ? "GitHub automations need one of your repositories."
                : "Optional: its runs start with this repository checked out."}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">When it runs</span>
            <span className="text-sm">{describeTrigger(shared.trigger)}</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Model</span>
            <span className="text-sm">{model === null ? "Default (box model)" : modelDisplayName(model)}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Prompt</span>
            <pre className="max-h-64 overflow-auto rounded-md bg-input p-3 font-sans text-sm whitespace-pre-wrap">
              {shared.prompt}
            </pre>
          </div>

          {sharedRepoUnavailable && (
            <Alert variant="warning">
              Kestrel could not confirm that your GitHub connection can read{" "}
              <span className="font-mono">{sharedRepo}</span>. Pick one of your repositories
              {repoRequired ? "." : " or import without one."}
            </Alert>
          )}
          {repos.isError && <Alert variant="warning">{errorText(repos.error)}</Alert>}
          {create.error && <Alert>{errorText(create.error)}</Alert>}

          <div className="flex justify-end gap-2">
            <Button asChild variant="ghost">
              <Link to="/settings/automations">Cancel</Link>
            </Button>
            <Button type="button" disabled={!canImport || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Importing…" : "Import automation"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

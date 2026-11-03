import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CreateFleetBoxBody, type CreatedFleetBox, type FleetBox } from "@cloudagents/protocol"
import { Either, Schema } from "effect"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { BOX_FORM_ERROR, OnlineBadge } from "@/components/Boxes"
import { Alert } from "@cloudagents/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SERVER_URL } from "@/config"
import { errorText } from "@/util"

/** Validates a managed box's name and URL the way the server does; a trailing slash is dropped first. */
function parseFleetForm(name: string, url: string): CreateFleetBoxBody | null {
  const result = Schema.decodeUnknownEither(CreateFleetBoxBody)({
    name: name.trim(),
    url: url.trim().replace(/\/+$/, ""),
  })
  return Either.isRight(result) ? result.right : null
}

/** Settings › Fleet (operators only): Kestrel's managed boxes. Each one serves many users, reached directly at its URL. */
export function Fleet() {
  const fleet = useQuery(queries.fleetBoxes())
  const [created, setCreated] = useState<CreatedFleetBox | null>(null)
  const boxes = fleet.data?.boxes ?? []

  return (
    <>
      {fleet.error && <Alert>{errorText(fleet.error)}</Alert>}
      {fleet.isPending && <div className="text-muted-foreground">Loading…</div>}
      {created && <FleetSecretCard created={created} onDismiss={() => setCreated(null)} />}
      {fleet.data && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            {boxes.length === 0 && <div className="px-5 py-4 text-muted-foreground">No managed boxes yet.</div>}
            {boxes.map((box) => (
              <FleetBoxRow key={box.id} box={box} onSecret={setCreated} />
            ))}
          </CardContent>
        </Card>
      )}
      <AddFleetBoxForm onCreated={setCreated} />
    </>
  )
}

function FleetBoxRow({ box, onSecret }: { box: FleetBox; onSecret: (created: CreatedFleetBox) => void }) {
  const queryClient = useQueryClient()
  const health = useQuery(queries.boxHealth(box.url))
  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.fleetBoxes })
  const setState = useMutation({
    mutationFn: (state: "active" | "draining") => api.updateFleetBox(box.id, { state }),
    onSuccess: invalidate,
  })
  const rotate = useMutation({
    mutationFn: () => api.rotateFleetBoxSecret(box.id),
    onSuccess: onSecret,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteFleetBox(box.id),
    onSuccess: invalidate,
  })
  const pending = setState.isPending || rotate.isPending || remove.isPending
  const error = setState.error ?? rotate.error ?? remove.error
  const variant = box.state === "active" ? "success" : box.state === "draining" ? "warning" : "neutral"

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{box.name}</span>
            <Badge variant={variant}>{box.state}</Badge>
            <OnlineBadge online={health.data?.online} />
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">{box.url}</span>
        </div>
        <span className="text-xs text-muted-foreground">{box.users === 1 ? "1 user" : `${box.users} users`}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <div className="ml-auto flex items-center gap-1">
          {box.state === "active" ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setState.mutate("draining")}>
              Drain
            </Button>
          ) : (
            <Button variant="soft" size="sm" disabled={pending} onClick={() => setState.mutate("active")}>
              Activate
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Generate a new secret? The old one stops working, so restart the box with the new one.")) {
                rotate.mutate()
              }
            }}
          >
            Rotate secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${box.name}? Its ${box.users} assigned users move to another active box, and threads stored on it stop being reachable.`,
                )
              ) {
                remove.mutate()
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {error && <Alert>{errorText(error)}</Alert>}
    </div>
  )
}

function AddFleetBoxForm({ onCreated }: { onCreated: (created: CreatedFleetBox) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [invalid, setInvalid] = useState(false)
  const create = useMutation({
    mutationFn: (body: CreateFleetBoxBody) => api.createFleetBox(body),
    onSuccess: (next) => {
      setName("")
      setUrl("")
      void queryClient.invalidateQueries({ queryKey: keys.fleetBoxes })
      onCreated(next)
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = parseFleetForm(name, url)
    setInvalid(body === null)
    if (body) create.mutate(body)
  }

  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <span className="font-medium">Add a managed box</span>
            <p className="text-muted-foreground">
              A new box is pending and gets no users until it is activated. Its start command is shown once after it is
              added.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Box name"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="sm:w-48"
            />
            <Input
              aria-label="Box URL"
              placeholder="https://box-1.kestrel.example"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={create.isPending}>
              Add box
            </Button>
          </div>
        </form>
        {invalid && <Alert>{BOX_FORM_ERROR}</Alert>}
        {create.error && <Alert>{errorText(create.error)}</Alert>}
      </CardContent>
    </Card>
  )
}

/** Shown once after a managed box is added or its secret is rotated: the box runs with these values. */
function FleetSecretCard({ created, onDismiss }: { created: CreatedFleetBox; onDismiss: () => void }) {
  const { box, secret } = created
  const command = `CLOUDAGENTS_CONTROL_URL=${SERVER_URL} CLOUDAGENTS_BOX_ID=${box.id} CLOUDAGENTS_BOX_SECRET=${secret} CLOUDAGENTS_BOX_MANAGED=1 nix run .#box`
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-5">
        <span className="font-medium">Secret for {box.name}</span>
        <p className="text-muted-foreground">
          Shown once. Start the managed box with this command on a machine Kestrel can reach at {box.url}. Activate it
          once it is running to give it users.
        </p>
        <code className="break-all rounded-lg bg-white/[0.06] p-3 font-mono text-xs">{command}</code>
        <div className="flex gap-2">
          <Button variant="soft" size="sm" onClick={() => void navigator.clipboard.writeText(command)}>
            Copy command
          </Button>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

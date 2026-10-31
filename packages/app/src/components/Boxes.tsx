import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CreateBoxBody, MAX_USER_BOXES, type CreatedBox, type UserBox } from "@cloudagents/protocol"
import { Either, Schema } from "effect"
import { api } from "@/api/client"
import { applyBoxList, keys, queries } from "@/api/queries"
import { useBox } from "@/components/BoxStatus"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SERVER_URL } from "@/config"
import { useActiveBoxId, useSetActiveBox } from "@/hooks/useActiveBox"
import { errorText } from "@/util"

const BOX_FORM_ERROR =
  "Name must be 1–64 characters. The URL must be an origin such as https://box.example.com (http is allowed only for localhost)."

/** Validates a box name and URL the way the server does; a trailing slash is dropped first. */
function parseBoxForm(name: string, url: string): CreateBoxBody | null {
  const result = Schema.decodeUnknownEither(CreateBoxBody)({ name: name.trim(), url: url.trim().replace(/\/+$/, "") })
  return Either.isRight(result) ? result.right : null
}

/** Settings › Boxes: where the apps send their requests. Kestrel's box is the default; your own box is reached at its URL. */
export function Boxes() {
  const queryClient = useQueryClient()
  const boxes = useQuery(queries.boxes())
  const activeBoxId = useActiveBoxId()
  const setActive = useSetActiveBox()
  const kestrel = useBox()
  const [created, setCreated] = useState<CreatedBox | null>(null)
  const list = boxes.data?.boxes ?? []

  return (
    <>
      {boxes.error && <Alert>{errorText(boxes.error)}</Alert>}
      {setActive.error && <Alert>{errorText(setActive.error)}</Alert>}
      {boxes.isPending && <div className="text-muted-foreground">Loading…</div>}
      {created && <SecretCard created={created} onDismiss={() => setCreated(null)} />}
      {boxes.data && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            <div className="flex items-start gap-4 px-5 py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">Kestrel&apos;s box</span>
                  {activeBoxId === null && <Badge variant="success">active</Badge>}
                  <OnlineBadge online={kestrel?.online} />
                </div>
                <span className="text-xs text-muted-foreground">Hosted by Kestrel. Used when no box of your own is active.</span>
              </div>
              {activeBoxId !== null && (
                <Button variant="soft" size="sm" disabled={setActive.isPending} onClick={() => setActive.mutate(null)}>
                  Use this box
                </Button>
              )}
            </div>
            {list.map((box) => (
              <UserBoxRow
                key={box.id}
                box={box}
                active={activeBoxId === box.id}
                busy={setActive.isPending}
                onUse={setActive.mutate}
                onSecret={setCreated}
              />
            ))}
          </CardContent>
        </Card>
      )}
      {boxes.data &&
        (list.length >= MAX_USER_BOXES ? (
          <p className="text-xs text-muted-foreground">You can add up to {MAX_USER_BOXES} boxes.</p>
        ) : (
          <AddBoxForm
            onCreated={(next) => {
              setCreated(next)
              void queryClient.invalidateQueries({ queryKey: keys.boxes })
            }}
          />
        ))}
    </>
  )
}

function OnlineBadge({ online }: { online: boolean | undefined }) {
  if (online === undefined) return <Badge variant="neutral">checking</Badge>
  return online ? <Badge variant="success">online</Badge> : <Badge variant="neutral">offline</Badge>
}

function UserBoxRow({
  box,
  active,
  busy,
  onUse,
  onSecret,
}: {
  box: UserBox
  active: boolean
  busy: boolean
  onUse: (boxId: string) => void
  onSecret: (created: CreatedBox) => void
}) {
  const queryClient = useQueryClient()
  const health = useQuery(queries.boxHealth(box.url))
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(box.name)
  const [url, setUrl] = useState(box.url)
  const [invalid, setInvalid] = useState(false)

  const update = useMutation({
    mutationFn: (body: CreateBoxBody) => api.updateBox(box.id, body),
    onSuccess: async (next) => {
      setEditing(false)
      await applyBoxList(queryClient, next)
    },
  })
  const regenerate = useMutation({
    mutationFn: () => api.regenerateBoxSecret(box.id),
    onSuccess: onSecret,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteBox(box.id),
    onSuccess: (next) => applyBoxList(queryClient, next),
  })
  const pending = update.isPending || regenerate.isPending || remove.isPending
  const error = update.error ?? regenerate.error ?? remove.error

  function startEdit() {
    setName(box.name)
    setUrl(box.url)
    setInvalid(false)
    setEditing(true)
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = parseBoxForm(name, url)
    setInvalid(body === null)
    if (body) update.mutate(body)
  }

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{box.name}</span>
            {active && <Badge variant="success">active</Badge>}
            <OnlineBadge online={health.data?.online} />
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">{box.url}</span>
        </div>
        {!active && (
          <Button variant="soft" size="sm" disabled={busy || pending} onClick={() => onUse(box.id)}>
            Use this box
          </Button>
        )}
      </div>

      {editing && (
        <form onSubmit={save} className="flex flex-wrap gap-2">
          <Input aria-label="Box name" value={name} onChange={(e) => setName(e.target.value)} className="sm:w-48" />
          <Input aria-label="Box URL" value={url} onChange={(e) => setUrl(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" disabled={update.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {editing && invalid && <Alert>{BOX_FORM_ERROR}</Alert>}

      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={pending} onClick={startEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Generate a new secret? The old one stops working, so restart the box with the new one."))
                regenerate.mutate()
            }}
          >
            Regenerate secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Remove this box? Kestrel forgets it and its secret. The box itself is not changed.")) {
                remove.mutate()
              }
            }}
          >
            Remove
          </Button>
        </div>
      </div>
      {error && <Alert>{errorText(error)}</Alert>}
    </div>
  )
}

function AddBoxForm({ onCreated }: { onCreated: (created: CreatedBox) => void }) {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [invalid, setInvalid] = useState(false)
  const create = useMutation({
    mutationFn: (body: CreateBoxBody) => api.createBox(body),
    onSuccess: (next) => {
      setName("")
      setUrl("")
      onCreated(next)
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = parseBoxForm(name, url)
    setInvalid(body === null)
    if (body) create.mutate(body)
  }

  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <span className="font-medium">Add a box</span>
            <p className="text-muted-foreground">
              Run the box on a machine you control and enter the address where it can be reached.
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
              placeholder="https://box.example.com"
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

/** Shown once after a box is added or its secret is regenerated: the secret is not kept anywhere the user can read later. */
function SecretCard({ created, onDismiss }: { created: CreatedBox; onDismiss: () => void }) {
  const { box, secret } = created
  const command = `CLOUDAGENTS_CONTROL_URL=${SERVER_URL} CLOUDAGENTS_BOX_ID=${box.id} CLOUDAGENTS_BOX_SECRET=${secret} nix run .#box`
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-5">
        <span className="font-medium">Secret for {box.name}</span>
        <p className="text-muted-foreground">
          Shown once. In a Kestrel checkout, start the box with this command. It listens on 127.0.0.1:8787
          (CLOUDAGENTS_PORT changes it); make that reachable at {box.url}, for example with Tailscale Serve or a
          Cloudflare Tunnel, or add the box as http://localhost:8787 to use it from the same machine.
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

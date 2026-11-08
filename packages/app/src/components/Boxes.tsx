import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ControlPaths, CreateBoxBody, MAX_USER_BOXES, type BoxList, type CreatedBox, type NestBoxStatus, type UserBox } from "@cloudagents/protocol"
import { Either, Schema } from "effect"
import { Link } from "react-router-dom"
import { api } from "@/api/client"
import { applyBoxList, keys, queries } from "@/api/queries"
import { useBox, useBoxCapabilities } from "@/components/BoxStatus"
import { Alert } from "@cloudagents/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SERVER_URL } from "@/config"
import { useActiveBoxId, useSetActiveBox } from "@/hooks/useActiveBox"
import { BOX_URL_ERROR, boxUrlKind, checkReach, parseBoxUrl, reachText } from "@/lib/boxReach"
import { errorText, formatSize } from "@/util"

/** Kestrel's managed box: its own health, reached directly (absent until one is assigned). */
function ManagedOnline({ url }: { url: string }) {
  const health = useQuery(queries.boxHealth(url))
  return <OnlineBadge online={health.data?.online} />
}

export const BOX_FORM_ERROR =
  "Name must be 1–64 characters. The URL must be an origin such as https://box.example.com (http is allowed only for localhost)."

/** How often a Nest box is read again while it starts or runs a command. */
const NEST_POLL_MS = 2_000

/** What a Nest box is doing while a command runs; shown beside its state. */
const NEST_PENDING_LABEL: Record<NonNullable<NestBoxStatus["pending"]>, string> = {
  resume: "Resuming…",
  suspend: "Suspending…",
  park: "Parking…",
  setLimits: "Resizing…",
  gpuAttach: "Attaching GPU…",
  gpuDetach: "Detaching GPU…",
  destroy: "Deleting…",
}

/** Validates a box name and URL the way the server does; a trailing slash is dropped first. */
export function parseBoxForm(name: string, url: string): CreateBoxBody | null {
  const result = Schema.decodeUnknownEither(CreateBoxBody)({ name: name.trim(), url: url.trim().replace(/\/+$/, "") })
  return Either.isRight(result) ? result.right : null
}

/** Settings › Boxes: where the apps send their requests. Kestrel's box is the default; your own box is reached at its URL. */
export function Boxes() {
  const queryClient = useQueryClient()
  const me = useQuery(queries.me())
  // A Nest box that is starting or running a command changes on its own: read the list again until it settles.
  const boxes = useQuery({
    ...queries.boxes(),
    refetchInterval: (query) =>
      query.state.data?.boxes.some((box) => box.nest && (box.nest.state === "provisioning" || box.nest.pending !== null))
        ? NEST_POLL_MS
        : false,
  })
  const activeBoxId = useActiveBoxId()
  const setActive = useSetActiveBox()
  const kestrel = useBox()
  const [created, setCreated] = useState<CreatedBox | null>(null)
  const list = boxes.data?.boxes ?? []
  const managed = boxes.data?.managedBox ?? null

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
                  {managed === null ? <OnlineBadge online={kestrel?.online} /> : <ManagedOnline url={managed.url} />}
                </div>
                <span className="text-xs text-muted-foreground">Hosted by Kestrel. Used when no box of your own is active.</span>
              </div>
              {activeBoxId !== null && (
                <Button variant="soft" size="sm" disabled={setActive.isPending} onClick={() => setActive.mutate(null)}>
                  Use this box
                </Button>
              )}
            </div>
            {list.map((box) =>
              box.nest ? (
                <NestBoxRow
                  key={box.id}
                  box={box}
                  nest={box.nest}
                  active={activeBoxId === box.id}
                  busy={setActive.isPending}
                  onUse={setActive.mutate}
                />
              ) : (
                <UserBoxRow
                  key={box.id}
                  box={box}
                  active={activeBoxId === box.id}
                  busy={setActive.isPending}
                  onUse={setActive.mutate}
                  onSecret={setCreated}
                />
              ),
            )}
          </CardContent>
        </Card>
      )}
      <ActiveBoxFeatures />
      {boxes.data &&
        (list.length >= MAX_USER_BOXES ? (
          <p className="text-xs text-muted-foreground">You can add up to {MAX_USER_BOXES} boxes.</p>
        ) : (
          <>
            {me.data?.nestEnabled && <NestCreateForm />}
            <PairHint />
            <AddBoxForm
              onCreated={(next) => {
                setCreated(next)
                void queryClient.invalidateQueries({ queryKey: keys.boxes })
              }}
            />
          </>
        ))}
    </>
  )
}

export function OnlineBadge({ online }: { online: boolean | undefined }) {
  if (online === undefined) return <Badge variant="neutral">checking</Badge>
  return online ? <Badge variant="success">online</Badge> : <Badge variant="neutral">offline</Badge>
}

/** What the active box adds beyond its agents: a GPU on request and suspend when idle. Empty while unknown. */
export function ActiveBoxFeatures() {
  const capabilities = useBoxCapabilities()
  if (capabilities === null) return null
  const gpu = capabilities.gpu === "on-demand" ? "GPU on request" : capabilities.gpu === "static" ? "GPU" : null
  if (gpu === null && capabilities.suspend !== true) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Active box:</span>
      {gpu !== null && <Badge variant="neutral">{gpu}</Badge>}
      {capabilities.suspend === true && <Badge variant="neutral">Suspends when idle</Badge>}
    </div>
  )
}

const INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/jarenm1/kestrel/main/scripts/install-box.sh | sh"

/** The installer for each OS the box supports; it always runs on Linux, natively, in WSL2 or in a Lima VM. */
const INSTALLERS = [
  { os: "linux", label: "Linux", command: INSTALL_SH, note: "Or: npx kestrel-box login && npx kestrel-box install" },
  {
    os: "macos",
    label: "macOS",
    command: `brew install lima && ${INSTALL_SH}`,
    note: "The installer runs the box in a Lima VM and forwards port 8787 to the Mac.",
  },
  {
    os: "windows",
    label: "Windows",
    command: "irm https://raw.githubusercontent.com/jarenm1/kestrel/main/scripts/install-box.ps1 | iex",
    note: "In PowerShell. Needs WSL2 with systemd; the box runs inside it.",
  },
] as const

const BOX_GUIDE_URL = "https://github.com/jarenm1/kestrel/blob/main/docs/byo-box.md"

/** The quickest way to add a box: the installer pairs each machine with your account, then its code is approved on the pairing page. */
function PairHint() {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div>
          <span className="font-medium">Add your machines</span>
          <p className="text-muted-foreground">
            Run the installer on each machine. It shows a code; approve it on the{" "}
            <Link to={ControlPaths.pairPage} className="text-foreground underline underline-offset-4">
              pairing page
            </Link>
            . Every machine becomes its own box in this list.
          </p>
        </div>
        <Tabs defaultValue="linux" className="gap-2">
          <TabsList className="h-8">
            {INSTALLERS.map((installer) => (
              <TabsTrigger key={installer.os} value={installer.os}>
                {installer.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {INSTALLERS.map((installer) => (
            <TabsContent key={installer.os} value={installer.os} className="flex flex-col gap-2">
              <code className="break-all rounded-lg bg-white/[0.06] p-3 font-mono text-xs">{installer.command}</code>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex-1 text-xs text-muted-foreground">{installer.note}</span>
                <Button variant="soft" size="sm" onClick={() => void navigator.clipboard.writeText(installer.command)}>
                  Copy command
                </Button>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}

/** Which address to give a box: localhost for this machine only, else HTTPS, with Tailscale as the optional easy path. */
export function AddressHelp() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
      <li>
        Same machine: <code className="font-mono">http://localhost:8787</code>. localhost is the machine the browser runs
        on, so it works only there.
      </li>
      <li>
        Other devices: an HTTPS address. Easiest, if you use Tailscale: Tailscale Serve gives the machine an{" "}
        <code className="font-mono">https://….ts.net</code> address for devices signed in to the same tailnet. A
        Cloudflare Tunnel or your own domain works too. Point it straight at the box port; the box keeps its private
        endpoints on loopback, so no filtering proxy is needed. The{" "}
        <a href={BOX_GUIDE_URL} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">
          box guide
        </a>{" "}
        has the details.
      </li>
      <li>Plain http:// to another machine, even on the same Wi-Fi, cannot be reached from the app.</li>
    </ul>
  )
}

/**
 * An explicit check of the entered URL's health from this device only. Nothing is requested until the button is
 * pressed and the URL is valid. Editing the URL starts over, so a result never outlives the URL it was taken for.
 */
export function ReachCheck({ url }: { url: string }) {
  return <UrlReachCheck key={url} url={url} />
}

function UrlReachCheck({ url }: { url: string }) {
  const [invalid, setInvalid] = useState(false)
  const check = useMutation({
    mutationFn: async (target: string) => ({ url: target, reachable: await checkReach(target, api.checkBox) }),
  })
  const result = check.data

  function run() {
    const target = parseBoxUrl(url)
    setInvalid(target === null)
    if (target !== null) check.mutate(target)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={check.isPending} onClick={run}>
          {check.isPending ? "Checking…" : "Check from this device"}
        </Button>
        {result && (
          <Badge variant={result.reachable ? "success" : "neutral"}>
            {result.reachable ? "reachable from this device" : "unreachable from this device"}
          </Badge>
        )}
      </div>
      {result && <p className="text-xs text-muted-foreground">{reachText(boxUrlKind(result.url), result.reachable)}</p>}
      {invalid && <p className="text-xs text-muted-foreground">{BOX_URL_ERROR}</p>}
    </div>
  )
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
      {editing && <ReachCheck url={url} />}
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

/** A Nest VM the user owns: its state and size, and the actions that state allows. */
function NestBoxRow({
  box,
  nest,
  active,
  busy,
  onUse,
}: {
  box: UserBox
  nest: NestBoxStatus
  active: boolean
  busy: boolean
  onUse: (boxId: string) => void
}) {
  const queryClient = useQueryClient()
  const action = useMutation({
    mutationFn: (act: () => Promise<BoxList>) => act(),
    onSuccess: (next) => applyBoxList(queryClient, next),
  })
  const locked = busy || action.isPending || nest.pending !== null
  const gpu = nest.gpus > 0 ? "GPU attached" : nest.limits.gpu === "on-demand" ? "GPU on demand" : "no GPU"
  const variant = nest.failed ? "destructive" : nest.state === "running" ? "success" : nest.state === "provisioning" ? "info" : "neutral"

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">{box.name}</span>
            {active && <Badge variant="success">active</Badge>}
            <Badge variant={variant}>{nest.failed ? "failed" : nest.state}</Badge>
            {nest.pending && <span className="text-xs text-muted-foreground">{NEST_PENDING_LABEL[nest.pending]}</span>}
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">{box.url}</span>
          <span className="text-xs text-muted-foreground">
            {nest.vcpus} vCPU · {formatSize(nest.memoryBytes)} RAM · {gpu} · {formatSize(nest.limits.volumeBytes)} disk
          </span>
        </div>
        {!active && !nest.failed && (
          <Button variant="soft" size="sm" disabled={busy || action.isPending} onClick={() => onUse(box.id)}>
            Use this box
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <div className="ml-auto flex items-center gap-1">
          {(nest.state === "suspended" || nest.state === "parked") && (
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => action.mutate(() => api.resumeNestBox(box.id))}>
              Resume
            </Button>
          )}
          {nest.state === "running" && (
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => action.mutate(() => api.suspendNestBox(box.id))}>
              Suspend
            </Button>
          )}
          {(nest.state === "running" || nest.state === "suspended") && (
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => action.mutate(() => api.parkNestBox(box.id))}>
              Park
            </Button>
          )}
          {nest.state === "running" && nest.limits.gpu === "on-demand" && nest.gpus > 0 && (
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => action.mutate(() => api.detachNestGpu(box.id))}>
              Detach GPU
            </Button>
          )}
          {nest.state === "running" && nest.limits.gpu === "on-demand" && nest.gpus === 0 && (
            <Button variant="ghost" size="sm" disabled={locked} onClick={() => action.mutate(() => api.attachNestGpu(box.id))}>
              Attach GPU
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              if (window.confirm("Delete this box? Kestrel wipes its volume, and it cannot be recovered.")) {
                action.mutate(() => api.deleteBox(box.id))
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {action.error && <Alert>{errorText(action.error)}</Alert>}
    </div>
  )
}

/** Creates a Nest box at the standard shape: Kestrel places it on a host with room. */
function NestCreateForm() {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const create = useMutation({
    mutationFn: () => api.createNestBox({ name: name.trim() }),
    onSuccess: async (next) => {
      setName("")
      await applyBoxList(queryClient, next)
    },
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
      className="flex flex-wrap gap-2"
    >
      <Input
        aria-label="Nest box name"
        placeholder="Nest box name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="sm:w-48"
      />
      <Button type="submit" size="sm" disabled={create.isPending || name.trim() === ""}>
        Create Nest box
      </Button>
      {create.error && <Alert>{errorText(create.error)}</Alert>}
    </form>
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
            <span className="font-medium">Add a box by URL</span>
            <p className="text-muted-foreground">
              For a box you started yourself. Enter the address this device and your others use to reach it.
            </p>
          </div>
          <AddressHelp />
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
        <ReachCheck url={url} />
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

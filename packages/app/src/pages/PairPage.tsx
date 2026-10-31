import { useState, type FormEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ApprovePairingBody, MAX_USER_BOXES, type PendingPairing } from "@cloudagents/protocol"
import { Link, useSearchParams } from "react-router-dom"
import { ApiError, api } from "@/api/client"
import { applyBoxList, queries, queryClient } from "@/api/queries"
import { BOX_FORM_ERROR, parseBoxForm } from "@/components/Boxes"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { errorText, formatTime } from "@/util"

/** A pairing code is 8 characters, shown as XXXX-XXXX. */
const CODE_LENGTH = 8

/** The URL a box is paired with when the CLI suggested none: the CLI's own local box. */
const DEFAULT_BOX_URL = "http://localhost:8787"

/** Case, dashes and spaces do not matter: what is kept is the code's characters, upper-cased and at most 8. */
function normalizeCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, CODE_LENGTH)
}

/** The message for a failed pairing call; the statuses the server answers with are spelled out. */
function pairingError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "Code not found or expired"
  if (e instanceof ApiError && e.status === 409) {
    return e.message.includes("boxes per user")
      ? `You can add up to ${MAX_USER_BOXES} boxes.`
      : "This code was already approved."
  }
  return errorText(e)
}

/** Approval page of `kestrel-box login`: the signed-in user checks the code the terminal shows and approves it. */
export function PairPage() {
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState(() => normalizeCode(searchParams.get("code") ?? ""))
  const pending = useQuery({ ...queries.pairing(code), enabled: code.length === CODE_LENGTH })

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Pair a box</h1>
        <p className="text-muted-foreground">
          Enter the code your terminal shows to add that machine as one of your boxes.
        </p>
      </div>
      <Card className="py-0">
        <CardContent className="flex flex-col gap-4 px-5 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Pairing code</span>
            <Input
              value={code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              className="font-mono tracking-widest"
            />
          </label>
          {pending.isFetching && <div className="text-muted-foreground">Loading…</div>}
          {pending.error && <Alert>{pairingError(pending.error)}</Alert>}
          {pending.data && <PairingForm code={code} pending={pending.data} />}
        </CardContent>
      </Card>
    </div>
  )
}

/** The box the CLI suggested, editable before approval. Mounted once the code's pending pairing has loaded. */
function PairingForm({ code, pending }: { code: string; pending: PendingPairing }) {
  const [name, setName] = useState(pending.name ?? "")
  const [url, setUrl] = useState(pending.url ?? DEFAULT_BOX_URL)
  const [activate, setActivate] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const approve = useMutation({
    mutationFn: (body: ApprovePairingBody) => api.approvePairing(code, body),
    onSuccess: (list) => applyBoxList(queryClient, list),
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = parseBoxForm(name, url)
    setInvalid(body === null)
    if (body) approve.mutate({ ...body, activate })
  }

  if (approve.isSuccess) {
    return (
      <p>
        Paired. Your terminal will finish setup.{" "}
        <Link to="/settings/boxes" className="text-foreground underline underline-offset-4">
          Settings › Boxes
        </Link>
      </p>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Name</span>
        <Input aria-label="Box name" value={name} placeholder="Name" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">URL</span>
        <Input
          aria-label="Box URL"
          value={url}
          placeholder="https://box.example.com"
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2.5">
        <Checkbox checked={activate} onCheckedChange={(checked) => setActivate(checked === true)} />
        Use this box now
      </label>
      <span className="text-xs text-muted-foreground">Code expires {formatTime(pending.expiresAt)}.</span>
      {invalid && <Alert>{BOX_FORM_ERROR}</Alert>}
      {approve.error && <Alert>{pairingError(approve.error)}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" disabled={approve.isPending}>
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>
      </div>
    </form>
  )
}

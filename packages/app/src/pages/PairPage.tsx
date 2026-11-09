import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ApprovePairingBody, MAX_USER_BOXES, type PendingPairing } from "@cloudagents/protocol"
import { Link, useSearchParams } from "react-router-dom"
import { api } from "@/api/client"
import { ApiError } from "@/api/errors"
import { applyBoxList, queries, queryClient } from "@/api/queries"
import { BOX_FORM_ERROR, parseBoxForm } from "@/components/Boxes"
import { pairingPhase, pairingPollMs } from "@/lib/pairing"
import { Alert } from "@cloudagents/ui/alert"
import { Button } from "@cloudagents/ui/button"
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

/** Redraws the page while a code is pending, so `expiresAt` is enforced without waiting for the next poll. */
function useClock(intervalMs: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** The control plane answers 409 for a code approved in another tab or after a lost response. */
function alreadyApproved(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && !e.message.includes("boxes per user")
}

/** Approval page of `kestrel-box login`: the signed-in user checks the code the terminal shows and approves it. */
export function PairPage() {
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState(() => normalizeCode(searchParams.get("code") ?? ""))
  const [approved, setApproved] = useState(false)
  const now = useClock(1000)
  const pending = useQuery({
    ...queries.pairing(code),
    enabled: code.length === CODE_LENGTH && !approved,
    // Poll while the code can still change; a transient failure keeps polling, so the page recovers by itself.
    refetchInterval: (query) => {
      const error = query.state.error
      const conflict = error instanceof ApiError && error.status === 409
      const gone = error instanceof ApiError && error.status === 404
      return pairingPollMs(pairingPhase(query.state.data, approved || conflict, Date.now(), gone), error)
    },
    retry: (failureCount, error) =>
      failureCount < 3 && !(error instanceof ApiError && (error.status === 404 || error.status === 409)),
  })
  // A code approved elsewhere answers 409; it is a terminal state, not a retryable failure.
  const conflict = pending.error instanceof ApiError && pending.error.status === 409
  const gone = pending.error instanceof ApiError && pending.error.status === 404
  const phase = pairingPhase(pending.data, approved || conflict, now, gone)

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
              onChange={(e) => {
                setApproved(false)
                setCode(normalizeCode(e.target.value))
              }}
              className="font-mono tracking-widest"
            />
          </label>
          {pending.isFetching && pending.data === undefined && !gone && (
            <div className="text-muted-foreground">Loading…</div>
          )}
          {pending.error && (phase === undefined || phase._tag === "pending") && (
            <Alert>{pairingError(pending.error)}</Alert>
          )}
          {phase?._tag === "pending" && (
            <PairingForm code={code} pending={phase.pending} onApproved={() => setApproved(true)} />
          )}
          {phase?._tag === "approved" && <Paired text="Paired. Your terminal will finish setup." />}
          {phase?._tag === "expired" && (
            <Alert>This pairing code expired. Run `kestrel-box login` again to get a new code.</Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** The terminal state of a code: no form, whatever this page or another tab did with it. */
function Paired({ text }: { text: string }) {
  return (
    <p>
      {text}{" "}
      <Link to="/settings/boxes" className="text-foreground underline underline-offset-4">
        Settings › Boxes
      </Link>
    </p>
  )
}

/** The box the CLI suggested, editable before approval. Mounted once the code's pending pairing has loaded. */
function PairingForm({ code, pending, onApproved }: { code: string; pending: PendingPairing; onApproved: () => void }) {
  const [name, setName] = useState(pending.name ?? "")
  const [url, setUrl] = useState(pending.url ?? DEFAULT_BOX_URL)
  const [activate, setActivate] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const approve = useMutation({
    mutationFn: (body: ApprovePairingBody) => api.approvePairing(code, body),
    onSuccess: (list) => {
      applyBoxList(queryClient, list)
      onApproved()
    },
  })

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = parseBoxForm(name, url)
    setInvalid(body === null)
    if (body) approve.mutate({ ...body, activate })
  }

  if (alreadyApproved(approve.error)) {
    return <Paired text="This code was already approved. Your terminal will finish setup." />
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

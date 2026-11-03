import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { WebhookEndpoint } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys } from "@/api/queries"
import { Field, WebhookBoxFields } from "@/components/AutomationEditDialog"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { errorText } from "@/util"

/** Creates a webhook automation. The URL and secret are shown once, after a successful create. */
export function AutomationCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>{open && <CreateWebhookForm onDone={onClose} />}</DialogContent>
    </Dialog>
  )
}

function CreateWebhookForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [preferredBoxId, setPreferredBoxId] = useState<string | null>(null)
  const [onUnavailable, setOnUnavailable] = useState<WebhookEndpoint["onUnavailable"]>("retry")
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api.createAutomation({
        name: name.trim(),
        prompt: prompt.trim(),
        trigger: { _tag: "webhook" },
        webhook: { preferredBoxId, onUnavailable },
      }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: keys.automations })
      if (saved.webhook !== null && saved.webhookSecret !== null) {
        setCreated({ url: saved.webhook.url, secret: saved.webhookSecret })
      } else {
        onDone()
      }
    },
  })

  if (created !== null) {
    return (
      <>
        <DialogTitle>Webhook ready</DialogTitle>
        <DialogDescription>
          Send requests to this URL. The secret is shown once and is not available after you close this dialog.
        </DialogDescription>
        <div className="flex flex-col gap-4">
          <Field label="Webhook URL">
            <div className="flex gap-2">
              <Input readOnly value={created.url} className="font-mono" />
              <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(created.url)}>
                Copy
              </Button>
            </div>
          </Field>
          <Field label="Secret (shown once)">
            <div className="flex gap-2">
              <Input readOnly value={created.secret} className="font-mono" />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(created.secret)}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Send it as Authorization: Bearer, or sign the body with HMAC-SHA256 and send X-Kestrel-Signature:
              sha256=… .
            </p>
          </Field>
          <div className="flex justify-end">
            <Button type="button" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      </>
    )
  }

  const canCreate = name.trim() !== "" && prompt.trim() !== ""

  return (
    <>
      <DialogTitle>New webhook automation</DialogTitle>
      <DialogDescription>Runs when a request arrives at its webhook.</DialogDescription>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCreate) create.mutate()
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Prompt">
          <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <WebhookBoxFields
          preferredBoxId={preferredBoxId}
          onUnavailable={onUnavailable}
          onPreferredBoxIdChange={setPreferredBoxId}
          onUnavailableChange={setOnUnavailable}
        />
        {create.error && <Alert>{errorText(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canCreate || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </>
  )
}

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ControlPaths, type Connection } from "@cloudagents/protocol"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SERVER_URL } from "@/config"
import { errorText } from "@/util"

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8

export function ConnectionsPage() {
  const connections = useQuery(queries.connections())

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 overflow-auto p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground">Accounts and keys Kestrel uses on your behalf.</p>
      </div>
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      {connections.isPending && <div className="text-muted-foreground">Loading…</div>}
      {connections.data && (
        <Card className="py-0">
          <CardContent className="divide-y px-0">
            {connections.data.map((connection) => (
              <ConnectionRow key={connection.provider} connection={connection} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ConnectionRow({ connection }: { connection: Connection }) {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState("")
  const onSuccess = () => void queryClient.invalidateQueries({ queryKey: keys.connections })

  const save = useMutation({
    mutationFn: (key: string) => api.putApiKey(connection.provider, { apiKey: key }),
    onSuccess: () => {
      setApiKey("")
      onSuccess()
    },
  })
  const disconnect = useMutation({ mutationFn: () => api.deleteConnection(connection.provider), onSuccess })
  const busy = save.isPending || disconnect.isPending
  const error = save.error ?? disconnect.error

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    save.mutate(apiKey.trim())
  }

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <div className="flex items-center gap-2">
        <strong>{connection.label}</strong>
        <Badge variant={connection.connected ? "success" : "neutral"}>
          {connection.connected ? "connected" : "not connected"}
        </Badge>
        {connection.connected && connection.account && (
          <span className="font-mono text-xs text-muted-foreground">{connection.account}</span>
        )}
      </div>
      {connection.kind === "oauth" ? (
        connection.available ? (
          <Button asChild variant="outline" className="w-fit">
            <a href={SERVER_URL + ControlPaths.connectOAuth(connection.provider)}>
              {connection.connected ? "Reconnect" : "Connect"}
            </a>
          </Button>
        ) : (
          <div className="text-muted-foreground">needs server config</div>
        )
      ) : (
        <form className="flex flex-wrap gap-2" onSubmit={submit}>
          <Input
            className="max-w-sm"
            type="password"
            autoComplete="off"
            placeholder={connection.connected ? "Replace API key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
            Save
          </Button>
          {connection.connected && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          )}
        </form>
      )}
      {error && <Alert>{errorText(error)}</Alert>}
    </div>
  )
}

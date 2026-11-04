import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  CLI_SIGN_IN,
  CliProvider,
  ControlPaths,
  MODEL_PROVIDERS,
  connectedModelProviders,
  providerModels,

  type CliLoginStart,
  type Connection,
  type AgentModel,
  type ModelProvider,
  type ModelProviderInfo,
} from "@cloudagents/protocol"
import { Schema } from "effect"
import { ChevronDown, Plus } from "lucide-react"
import { api } from "@/api/client"
import { keys, queries } from "@/api/queries"
import { Alert } from "@cloudagents/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@cloudagents/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { SERVER_URL } from "@/config"

import { setShownModels, useShownModels } from "@/hooks/useShownModels"
import { errorText } from "@/util"

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8

/** While a device-code sign-in is pending, connections are re-read at this interval until the box reports the login. */
const CLI_POLL_MS = 3000

const CLI_INTRO: Record<CliProvider, string> = {
  "claude-cli": "Use your own Claude Pro or Max subscription.",
  "codex-cli": "Use your own ChatGPT subscription.",
  "antigravity-cli": "Use your own Google account through Antigravity CLI.",
  "opencode-go": "Use your OpenCode Go subscription. The API key stays in OpenCode on your box.",
}

/** Body of Settings › Connections: the accounts and keys, then the models each provider shows in the chat picker. */
export function Connections() {
  const connections = useQuery(queries.connections())
  const capabilities = useQuery(queries.capabilities())
  const list = connections.data

  return (
    <>
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      {connections.isPending && <div className="text-muted-foreground">Loading…</div>}
      {list && (
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold tracking-tight">Accounts and subscriptions</h2>
          <Card className="py-0">
            <CardContent className="divide-y divide-white/[0.04] px-0">
              {list.filter((connection) => connection.kind !== "apikey").map((connection) =>
                connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) ? (
                  <CliConnectionRow key={connection.provider} connection={connection} provider={connection.provider} />
                ) : connection.kind === "cli" && connection.provider === "opencode" ? (
                  <FreeOpenCodeRow key={connection.provider} connection={connection} />
                ) : (
                  <ConnectionRow key={connection.provider} connection={connection} />
                ),
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {list && <ApiKeysCard connections={list} />}
      {list && <ModelListsCard connections={list} harnesses={capabilities.data?.harnesses} />}
    </>
  )
}

function ApiKeysCard({ connections }: { connections: readonly Connection[] }) {
  const [selected, setSelected] = useState<string[]>([])
  const providers = connections.filter((connection) => connection.kind === "apikey")
  const visible = providers.filter((connection) => connection.connected || selected.includes(connection.provider))
  const remaining = providers.filter((connection) => !connection.connected && !selected.includes(connection.provider))

  function remove(provider: string) {
    setSelected((current) => current.filter((id) => id !== provider))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold tracking-tight">API keys</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="soft" size="sm" disabled={remaining.length === 0}>
              <Plus />
              Add API key
              <ChevronDown className="opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-(--radix-dropdown-menu-content-available-height) min-w-56 overflow-y-auto"
          >
            {remaining.map((connection) => (
              <DropdownMenuItem
                key={connection.provider}
                onSelect={() => setSelected((current) => [...current, connection.provider])}
              >
                {connection.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {visible.length > 0 && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            {visible.map((connection) => (
              <ConnectionRow
                key={connection.provider}
                connection={connection}
                onRemove={() => remove(connection.provider)}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}


/** Per model provider, the models the chat's model picker offers; the rest stay out of the way. */
function ModelListsCard({
  connections,
  harnesses,
}: {
  connections: readonly Connection[]
  harnesses: readonly ModelProvider[] | undefined
}) {
  const connected = new Set(connectedModelProviders(connections, harnesses).map((p) => p.id))
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold tracking-tight">Models</h2>
      <Card className="py-0">
        <CardContent className="divide-y divide-white/[0.04] px-0">
          {MODEL_PROVIDERS.map((provider) => (
            <ModelListRow key={provider.id} provider={provider} connected={connected.has(provider.id)} />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function ModelListRow({ provider, connected }: { provider: ModelProviderInfo; connected: boolean }) {
  const all = providerModels(provider.id)
  const shown = useShownModels()[provider.id]
  const shownIds = new Set(shown.map((m) => m.id))

  function toggle(id: AgentModel, on: boolean) {
    setShownModels(provider.id, all.filter((m) => (m.id === id ? on : shownIds.has(m.id))).map((m) => m.id))
  }

  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <div className="flex flex-col gap-0.5">
        {provider.connections.length === 0 ? (
          <div className="flex items-center gap-2">
            <strong>{provider.name}</strong>
            <Badge variant="neutral">no sign-in needed</Badge>
          </div>
        ) : (
          <ConnectionHeader label={provider.name} connected={connected} />
        )}
        {provider.id === "opencode" && (
          <span className="text-xs text-muted-foreground">Free models need no Go key or broker credentials.</span>
        )}
        {!connected && (
          <span className="text-xs text-muted-foreground">
            {provider.connections.length === 0
              ? `${provider.name} is not installed on this box.`
              : "Connect a key or subscription above to use these."}
          </span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="soft" size="sm" className="ml-auto">
            {shown.length} of {all.length} shown
            <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-(--radix-dropdown-menu-content-available-height) min-w-56 overflow-y-auto"
        >
          <DropdownMenuLabel>{provider.name} models in chat</DropdownMenuLabel>
          {all.map((m) => (
            <DropdownMenuCheckboxItem
              key={m.id}
              checked={shownIds.has(m.id)}
              // Keeps the menu open so several models can be toggled in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => toggle(m.id, on)}
            >
              {m.name}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-muted-foreground" onSelect={() => setShownModels(provider.id, null)}>
            Reset to defaults
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Free OpenCode has installation state, not a key or subscription to manage. */
function FreeOpenCodeRow({ connection }: { connection: Connection }) {
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <ConnectionHeader label={connection.label} connected={connection.available} />
      <span className="text-xs text-muted-foreground">
        {connection.available
          ? "Installed on the box. Free models need no sign-in or Go key. MCP tools are available."
          : `${connection.error ?? "OpenCode is not installed on this box"}. Install OpenCode 2 to offer its free models.`}
      </span>
    </div>
  )
}

function ConnectionRow({ connection, onRemove }: { connection: Connection; onRemove?: () => void }) {
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
  const disconnect = useMutation({
    mutationFn: () => api.deleteConnection(connection.provider),
    onSuccess: () => {
      onRemove?.()
      onSuccess()
    },
  })
  const busy = save.isPending || disconnect.isPending
  const error = save.error ?? disconnect.error

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    save.mutate(apiKey.trim())
  }

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <ConnectionHeader
        label={connection.label}
        connected={connection.connected}
        account={connection.account}
        expired={connection.expired === true}
      />
      {connection.kind === "oauth" ? (
        connection.available ? (
          <Button asChild variant="soft" className="w-fit">
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
            aria-label={`${connection.label} API key`}
            placeholder={connection.connected ? "Replace API key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
            Save
          </Button>
          {connection.connected ? (
            <Button type="button" variant="soft" disabled={busy} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          ) : onRemove && (
            <Button type="button" variant="soft" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          )}
        </form>
      )}
      {error && <Alert>{errorText(error)}</Alert>}
    </div>
  )
}

function ConnectionHeader({
  label,
  connected,
  account,
  expired = false,
}: {
  label: string
  connected: boolean
  account?: string | null
  expired?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <strong>{label}</strong>
      {expired ? (
        <Badge variant="warning">expired</Badge>
      ) : (
        <Badge variant={connected ? "success" : "neutral"}>{connected ? "connected" : "not connected"}</Badge>
      )}
      {connected && account && <span className="font-mono text-xs text-muted-foreground">{account}</span>}
    </div>
  )
}

/**
 * Re-reads the connections, whose CLI and harness rows come from the active box, and the usage figures a changed login
 * moves.
 */
function invalidateConnections(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.connections })
  void queryClient.invalidateQueries({ queryKey: keys.usage })
  void queryClient.invalidateQueries({ queryKey: keys.providerUsage })
  void queryClient.invalidateQueries({ queryKey: keys.usageActivity })
}

/** Subscription logins of the official CLIs. The sign-in runs on the agent box; this page only relays the provider's own steps. */
function CliConnectionRow({ connection, provider }: { connection: Connection; provider: CliProvider }) {
  const queryClient = useQueryClient()
  const [login, setLogin] = useState<CliLoginStart | null>(null)
  const [expired, setExpired] = useState(false)
  const [code, setCode] = useState("")
  const [apiKey, setApiKey] = useState("")
  const refresh = () => invalidateConnections(queryClient)
  const keySignIn = CLI_SIGN_IN[provider] === "key"

  const start = useMutation({
    mutationFn: () => api.cliLoginStart(provider),
    onSuccess: (next) => {
      submitCode.reset()
      logout.reset()
      setLogin(next)
      setExpired(false)
      setCode("")
    },
  })
  const submitCode = useMutation({
    mutationFn: (value: string) => api.cliLoginCode(provider, { code: value }),
    onSuccess: (status) => {
      // Keep the pending sign-in unless the box confirms it took; the user can retry or cancel.
      if (status.loggedIn) {
        setLogin(null)
        setCode("")
      }
      refresh()
    },
  })
  const logout = useMutation({
    mutationFn: () => api.cliLogout(provider),
    onSuccess: () => {
      setLogin(null)
      refresh()
    },
  })
  const saveKey = useMutation({
    mutationFn: (key: string) => api.cliLoginKey(provider, { apiKey: key }),
    onSuccess: () => {
      setApiKey("")
      refresh()
    },
  })
  const busy = start.isPending || submitCode.isPending || saveKey.isPending || logout.isPending
  const error = start.error ?? submitCode.error ?? saveKey.error ?? logout.error

  useEffect(() => {
    if (connection.connected) setLogin(null)
  }, [connection.connected])

  useEffect(() => {
    if (!login) return
    const id = setTimeout(() => setExpired(true), Math.max(0, Date.parse(login.expiresAt) - Date.now()))
    return () => clearTimeout(id)
  }, [login])

  // A device-code sign-in finishes on the provider's page, so only a re-read shows it.
  const polling = login !== null && !login.needsCode && !expired && !connection.connected
  useEffect(() => {
    if (!polling) return
    const id = setInterval(() => invalidateConnections(queryClient), CLI_POLL_MS)
    return () => clearInterval(id)
  }, [polling, queryClient])

  function cancel() {
    start.reset()
    submitCode.reset()
    logout.reset()
    setLogin(null)
    setCode("")
  }

  function body() {
    if (!connection.available) {
      return (
        <>
          <p className="text-muted-foreground">{connection.error ?? "Agent box is offline."}</p>
          <Button variant="soft" className="w-fit" onClick={refresh}>
            Check again
          </Button>
        </>
      )
    }
    if (connection.connected) {
      return (
        <>
          <p className="text-muted-foreground">
            {connection.account ? `Signed in as ${connection.account}` : "Signed in"}
          </p>
          <Button
            variant="soft"
            className="w-fit"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Disconnect this subscription? Agent runs will stop using it.")) logout.mutate()
            }}
          >
            Disconnect
          </Button>
        </>
      )
    }
    if (keySignIn) {
      return (
        <>
          <p className="text-muted-foreground">{CLI_INTRO[provider]}</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              saveKey.mutate(apiKey.trim())
            }}
          >
            <Input
              className="max-w-sm"
              type="password"
              autoComplete="off"
              placeholder="API key"
              aria-label={`${connection.label} API key`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <Button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
              Save
            </Button>
          </form>
        </>
      )
    }
    if (login && expired) {
      return (
        <>
          <p className="text-muted-foreground">This sign-in expired.</p>
          <Button className="w-fit" disabled={busy} onClick={() => start.mutate()}>
            Try again
          </Button>
        </>
      )
    }
    if (login?.needsCode) {
      return (
        <>
          <Button asChild variant="soft" className="w-fit">
            <a href={login.url} target="_blank" rel="noopener noreferrer">
              Open sign-in page
            </a>
          </Button>
          <p className="text-muted-foreground">Sign in on that page, then paste the code it shows you.</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              submitCode.mutate(code.trim())
            }}
          >
            <Input
              className="max-w-xs"
              autoComplete="off"
              placeholder="Code"
              aria-label="Code from the sign-in page"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" disabled={busy || code.trim().length === 0}>
              Submit code
            </Button>
            <Button type="button" variant="soft" onClick={cancel}>
              Cancel
            </Button>
          </form>
        </>
      )
    }
    if (login) {
      return (
        <>
          <Button asChild variant="soft" className="w-fit">
            <a href={login.url} target="_blank" rel="noopener noreferrer">
              Open sign-in page
            </a>
          </Button>
          <p className="text-muted-foreground">Enter this code on the OpenAI page:</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-lg font-semibold tracking-widest">{login.userCode}</code>
            <Button variant="soft" size="sm" onClick={() => void navigator.clipboard.writeText(login.userCode ?? "")}>
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Waiting for you to approve the sign-in…</p>
        </>
      )
    }
    return (
      <>
        <p className="text-muted-foreground">
          {CLI_INTRO[provider]}
        </p>
        <Button className="w-fit" disabled={busy} onClick={() => start.mutate()}>
          Connect
        </Button>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 px-5 py-4">
      <ConnectionHeader label={connection.label} connected={connection.connected} />
      <div className="flex flex-col gap-2">{body()}</div>
      {error && <Alert>{errorText(error)}</Alert>}
    </div>
  )
}

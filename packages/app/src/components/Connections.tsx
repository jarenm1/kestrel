import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  AcpHarnessId,
  CliProvider,
  ControlPaths,
  HARNESS_IDS,
  HARNESS_LABELS,
  MODEL_PROVIDERS,
  connectedModelProviders,
  providerInfo,
  providerModels,
  providersForHarness,
  type CliAuthStatus,
  type CliLoginStart,
  type Connection,
  type AgentModel,
  type ModelProviderInfo,
} from "@cloudagents/protocol"
import { Schema } from "effect"
import { Check, ChevronDown } from "lucide-react"
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
import { useActiveBoxId } from "@/hooks/useActiveBox"
import { useEnabledHarnesses } from "@/hooks/useHarness"
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
}

/** Which agent CLIs chats may use. Each thread keeps its own model and harness; disabling one only narrows the menu. */
function HarnessCard({ connections }: { connections: readonly Connection[] | undefined }) {
  const [enabled, , toggle] = useEnabledHarnesses()

  return (
    <div className="flex flex-col gap-2">
      <div>
        <h2 className="font-semibold tracking-tight">Harnesses</h2>
        <p className="text-muted-foreground">
          The agent CLIs available to every thread. A thread's own model pick decides which one runs it; this list only
          controls what is on offer. A disabled harness never takes a thread's next message.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {HARNESS_IDS.map((id) => {
          const providers = providersForHarness(id)
          const provider = providers[0]
          const active = enabled.includes(id)
          // A standalone harness is only offered when the box reports it can launch that CLI at all.
          const row = provider?.standalone === true ? connections?.find((c) => c.provider === id) : undefined
          const missing = provider?.standalone === true && (row === undefined || row.available === false)
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(id)}
              className={
                active
                  ? "flex flex-col gap-1.5 rounded-xl border border-white/25 bg-white/[0.06] p-4 text-left transition-colors"
                  : "flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-card/40 p-4 text-left transition-colors hover:border-white/15 hover:bg-card/70"
              }
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                {HARNESS_LABELS[id]}
                {active && <Check className="ml-auto size-4 text-foreground/80" />}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {providers.map((p) => p.name).join(", ")}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {provider?.auth === "harness-login"
                  ? missing
                    ? (row?.error ?? "Not installed on this box")
                    : "Runs on the providers connected above"
                  : provider?.auth === "cli-login"
                    ? "API key or its CLI subscription"
                    : "API key from Connections"}
                {provider?.mcp === false ? " · no MCP tools" : " · MCP tools"}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Body of Settings › Connections: the accounts and keys, then the models each provider shows in the chat picker. */
export function Connections() {
  const connections = useQuery(queries.connections())
  const activeBoxId = useActiveBoxId()
  // With a user box active, the CLI sign-ins live on that box, so its login state replaces the relay's view of them.
  const direct = typeof activeBoxId === "string"
  const cliAuth = useQuery({ ...queries.cliAuth(), enabled: direct })
  const list = connections.data && (direct ? withBoxCli(connections.data, cliAuth.data) : connections.data)

  return (
    <>
      <HarnessCard connections={connections.data} />
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      {cliAuth.error && <Alert>{errorText(cliAuth.error)}</Alert>}
      {connections.isPending && <div className="text-muted-foreground">Loading…</div>}
      {list && (
        <Card className="py-0">
          <CardContent className="divide-y divide-white/[0.04] px-0">
            {list.map((connection) =>
              connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) ? (
                <CliConnectionRow key={connection.provider} connection={connection} provider={connection.provider} />
              ) : connection.kind === "cli" && Schema.is(AcpHarnessId)(connection.provider) ? (
                <HarnessConnectionRow key={connection.provider} connection={connection} harness={connection.provider} />
              ) : (
                <ConnectionRow key={connection.provider} connection={connection} />
              ),
            )}
          </CardContent>
        </Card>
      )}
      {list && <ModelListsCard connections={list} />}
    </>
  )
}

/**
 * Direct mode: the CLI rows take login state and availability from the user's box, where the CLI actually runs.
 * Labels and the provider list still come from the relay. Until the box answers, the CLI rows read as unavailable.
 */
function withBoxCli(connections: readonly Connection[], cliAuth: readonly CliAuthStatus[] | undefined): Connection[] {
  return connections.map((connection) => {
    // A standalone ACP harness has no CLI login to merge: the relay already reports whether the box can launch it.
    if (connection.kind !== "cli" || !Schema.is(CliProvider)(connection.provider)) return connection
    const status = cliAuth?.find((s) => s.provider === connection.provider)
    return {
      ...connection,
      connected: status?.loggedIn ?? false,
      account: status?.account ?? null,
      available: status !== undefined && status.error === undefined,
      error: status?.error,
    }
  })
}

/** Per model provider, the models the chat's model picker offers; the rest stay out of the way. */
function ModelListsCard({ connections }: { connections: readonly Connection[] }) {
  const connected = new Set(connectedModelProviders(connections).map((p) => p.id))
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h2 className="font-semibold tracking-tight">Models</h2>
        <p className="text-muted-foreground">Choose which models each provider offers in the chat's model picker.</p>
      </div>
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
        <ConnectionHeader label={provider.name} connected={connected} />
        {provider.standalone === true ? (
          <span className="text-xs text-muted-foreground">
            {provider.connections.length === 0 ? "No sign-in needed: " : ""}
            {connected
              ? "the box can launch this harness; it reaches models through Kestrel's broker."
              : `Not offered: this box does not have ${provider.name}'s CLI${provider.setup === undefined ? "" : ` (${provider.setup})`}.`}
            {provider.mcp ? " MCP tools are available." : " This adapter does not support MCP tools."}
          </span>
        ) : (
          !connected && <span className="text-xs text-muted-foreground">Connect a key or subscription above to use these.</span>
        )}
        {provider.hint !== undefined && <span className="text-xs text-muted-foreground">{provider.hint}</span>}
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

/**
 * A standalone ACP harness: the box reports whether its CLI is installed. It holds no credential of its own in a run —
 * Kestrel routes the harness's model calls through its broker — so there is nothing to connect or disconnect here.
 */
function HarnessConnectionRow({ connection, harness }: { connection: Connection; harness: AcpHarnessId }) {
  const provider = providerInfo(harness)
  return (
    <div className="flex flex-col gap-1 px-5 py-4">
      <ConnectionHeader label={connection.label} connected={connection.available} />
      <span className="text-xs text-muted-foreground">
        {connection.available
          ? `Installed on the box. Runs on the models you connected above.${provider.mcp ? " MCP tools are available." : " This adapter does not support MCP tools."}`
          : `${connection.error ?? "its CLI is not installed on the box"}. Install ${provider.name} on the box to offer it in the model picker.`}
      </span>
      {connection.available && provider.setup !== undefined && (
        <span className="text-xs text-muted-foreground">{provider.setup}</span>
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
            placeholder={connection.connected ? "Replace API key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
            Save
          </Button>
          {connection.connected && (
            <Button type="button" variant="soft" disabled={busy} onClick={() => disconnect.mutate()}>
              Disconnect
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

/** Re-reads the relay's connections and the box's CLI sign-ins, which the CLI rows show together. */
function invalidateConnections(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.connections })
  void queryClient.invalidateQueries({ queryKey: keys.cliAuth })
}

/** Subscription logins of the official CLIs. The sign-in runs on the agent box; this page only relays the provider's own steps. */
function CliConnectionRow({ connection, provider }: { connection: Connection; provider: CliProvider }) {
  const queryClient = useQueryClient()
  const [login, setLogin] = useState<CliLoginStart | null>(null)
  const [expired, setExpired] = useState(false)
  const [code, setCode] = useState("")
  const refresh = () => invalidateConnections(queryClient)

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
  const busy = start.isPending || submitCode.isPending || logout.isPending
  const error = start.error ?? submitCode.error ?? logout.error

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
              aria-label="Code from the Claude sign-in page"
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

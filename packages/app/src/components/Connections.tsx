import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  CLI_SIGN_IN,
  CliProvider,
  MODEL_PROVIDERS,
  providerModels,

  type CliLoginStart,
  type Connection,
  type AgentModel,
  type ModelProviderInfo,
} from "@cloudagents/protocol"
import { Schema } from "effect"
import { ChevronDown, Plus } from "lucide-react"
import { isRouteModel, modelDisplayName, modelHarnessOf } from "@cloudagents/composer/models"
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

import { setShownModels, useShownModels } from "@/hooks/useShownModels"
import { filterItemProps, useFilterMenu } from "@/hooks/useFilterMenu"
import { errorText } from "@/util"
import { HarnessLogo } from "@/components/HarnessLogo"
import { HARNESSES } from "@/lib/harnesses"

/** API keys shorter than this are rejected by the server (`PutApiKeyBody`). */
const MIN_API_KEY_LENGTH = 8

/** While a device-code sign-in is pending, connections are re-read at this interval until the box reports the login. */
const CLI_POLL_MS = 3000

const CLI_INTRO: Record<CliProvider, string> = {
  "claude-cli": "Use your own Claude Pro or Max subscription.",
  "codex-cli": "Use your own ChatGPT subscription.",
  "antigravity-cli": "Use your own Google account through Antigravity CLI.",
  "opencode": "Sign in with OpenCode Console to use free models. The login stays in OpenCode on your box.",
  "opencode-go": "Use your OpenCode Go subscription. The API key stays in OpenCode on your box.",
}

/** Key-based CLI logins belong with API keys, but keep their box-local authentication. */
function isApiKeyConnection(connection: Connection) {
  return connection.kind === "apikey" ||
    (connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) && CLI_SIGN_IN[connection.provider] === "key")
}

/** Model subscriptions, installed harnesses, and API keys with their chat model preferences. */
export function Connections() {
  const connections = useQuery(queries.connections())
  const list = connections.data

  return (
    <>
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      {connections.isPending && <div className="text-muted-foreground">Loading…</div>}
      {list && (
        <div className="flex flex-col gap-2">
          <h2 className="font-semibold tracking-tight">Harnesses/Subscriptions</h2>
          <Card className="py-0">
            <CardContent className="divide-y divide-white/[0.04] px-0">
              {list.filter((connection) => connection.kind === "cli" && !isApiKeyConnection(connection)).map((connection) =>
                connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) ? (
                  <CliConnectionRow key={connection.provider} connection={connection} provider={connection.provider} />
                ) : (
                  <ConnectionRow key={connection.provider} connection={connection} />
                ),
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {list && <ApiKeysCard connections={list} />}
    </>
  )
}

function ApiKeysCard({ connections }: { connections: readonly Connection[] }) {
  const [selected, setSelected] = useState<string[]>([])
  const providers = connections.filter(isApiKeyConnection)
  // Missing box auth is unknown state, not proof that a saved CLI key was removed.
  const visible = providers.filter((connection) =>
    connection.connected || selected.includes(connection.provider) || (connection.kind === "cli" && !connection.available),
  )
  const remaining = providers.filter((connection) => !visible.includes(connection))

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
      {visible.length > 0 ? (
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
      ) : (
        <p className="py-4 text-center text-muted-foreground">No api keys added</p>
      )}
    </div>
  )
}

/** Keep all row content aligned with the name, leaving the logo in its own hanging column. */
function HarnessRow({ connection, children }: { connection: Connection; children: ReactNode }) {
  const harness = HARNESSES.find((candidate) => candidate.connection === connection.provider)
  const modelProvider = MODEL_PROVIDERS.find(
    (provider) => provider.id === connection.provider || provider.connections.includes(connection.provider),
  )
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      {harness && <HarnessLogo harness={harness} className="mt-0.5 size-6" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <ConnectionHeader
            label={connection.label}
            connected={connection.connected}
            expired={connection.expired === true}
          />
          {modelProvider && <ModelPicker provider={modelProvider} allowRoutes={isApiKeyConnection(connection)} />}
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Height of the model list: ten items (2rem each), scrolling past that, less only when the window has less room. Fixed
 * for longer lists so the menu keeps its size while searching; shorter lists take their own height.
 */
const MODEL_LIST_ROWS = 10
const MODEL_LIST_HEIGHT = "min(20rem, calc(var(--radix-dropdown-menu-content-available-height) - 7rem))"

/**
 * Toggles which of the provider's models the chat's model picker offers, with a search box over the list. Routes appear
 * under the harness they run; a subscription row may only pick its native models, and a route the selected box cannot
 * launch is not offered at all.
 */
function ModelPicker({ provider, allowRoutes }: { provider: ModelProviderInfo; allowRoutes: boolean }) {
  const capabilities = useQuery(queries.capabilities())
  const modelHarnesses = capabilities.data?.modelHarnesses
  const all = providerModels(provider.id)
  const offerable = all.filter(
    (m) =>
      (allowRoutes || !isRouteModel(m)) &&
      (!isRouteModel(m) || modelHarnesses?.some((harness) => harness === modelHarnessOf(m).harness) === true),
  )
  const shown = useShownModels()[provider.id]
  const shownIds = new Set(shown.map((m) => m.id))
  const shownCount = offerable.filter((m) => shownIds.has(m.id)).length
  const menu = useFilterMenu(
    offerable,
    (m) => `${modelDisplayName(m)} ${m.name} ${m.id}`,
    (m) => toggle(m.id, !shownIds.has(m.id)),
    { keepOpen: true },
  )
  const groups = HARNESSES.map((harness) => ({
    harness,
    models: menu.matches.filter((m) => modelHarnessOf(m).harness === harness.id),
  })).filter((group) => group.models.length > 0)

  function toggle(id: AgentModel, on: boolean) {
    // Write the full list, so a route hidden by the other connection row keeps its stored choice.
    setShownModels(provider.id, all.filter((m) => (m.id === id ? on : shownIds.has(m.id))).map((m) => m.id))
  }

  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="soft"
          size="sm"
          className="ml-auto"
          aria-label={`Choose ${provider.name} models shown in chat`}
        >
          {shownCount} of {offerable.length} shown
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="flex w-72 max-w-(--radix-dropdown-menu-content-available-width) flex-col"
      >
        <DropdownMenuLabel>{provider.name} models in chat</DropdownMenuLabel>
        <Input
          {...menu.inputProps}
          placeholder="Search models"
          aria-label={`Search ${provider.name} models`}
          className="mb-1 h-8 shrink-0"
        />
        <div
          ref={menu.listRef}
          className="overflow-y-auto"
          style={offerable.length > MODEL_LIST_ROWS ? { height: MODEL_LIST_HEIGHT } : { maxHeight: MODEL_LIST_HEIGHT }}
        >
          {groups.map((group) => (
            <div key={group.harness.id}>
              <DropdownMenuLabel className="text-muted-foreground">{group.harness.name}</DropdownMenuLabel>
              {group.models.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={shownIds.has(m.id)}
                  // Keeps the menu open so several models can be toggled in one go.
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) => toggle(m.id, on)}
                  {...filterItemProps}
                >
                  <span className="min-w-0 flex-1 truncate">{modelDisplayName(m)}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          ))}
          {menu.matches.length === 0 && <DropdownMenuLabel>No model matches “{menu.query}”.</DropdownMenuLabel>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-muted-foreground" onSelect={() => setShownModels(provider.id, null)}>
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConnectionRow({ connection, onRemove }: { connection: Connection; onRemove?: () => void }) {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState("")
  const keyProvider = connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) &&
    CLI_SIGN_IN[connection.provider] === "key" ? connection.provider : null
  const onSuccess = () => invalidateConnections(queryClient)

  const save = useMutation({
    mutationFn: async (key: string) => {
      if (keyProvider) await api.cliLoginKey(keyProvider, { apiKey: key })
      else await api.putApiKey(connection.provider, { apiKey: key })
    },
    onSuccess: () => {
      setApiKey("")
      onSuccess()
    },
  })
  const disconnect = useMutation({
    mutationFn: () => keyProvider ? api.cliLogout(keyProvider) : api.deleteConnection(connection.provider),
    onSuccess: () => {
      onRemove?.()
      onSuccess()
    },
  })
  const busy = save.isPending || disconnect.isPending
  const error = save.error ?? disconnect.error
  // API-key access keeps its model preferences beside the key.
  const modelProvider = MODEL_PROVIDERS.find(
    (provider) => provider.connections.includes(connection.provider),
  )

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // The button reads Disconnect while the input is empty; Enter must not send an invalid key.
    if (apiKey.trim().length < MIN_API_KEY_LENGTH) return
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
      {keyProvider && <p className="text-xs text-muted-foreground">{CLI_INTRO[keyProvider]}</p>}
      {keyProvider && !connection.available ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground">{connection.error ?? "Agent box is offline."}</p>
          <Button variant="soft" onClick={onSuccess}>Check again</Button>
          {connection.connected && modelProvider && <ModelPicker provider={modelProvider} allowRoutes />}
        </div>
      ) : (
        <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
          <Input
            className="max-w-xs"
            type="password"
            autoComplete="off"
            aria-label={`${connection.label} API key`}
            placeholder={connection.connected ? "Replace API key" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {connection.connected && apiKey.trim().length === 0 ? (
            <Button type="button" variant="soft" disabled={busy} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          ) : (
            <Button type="submit" disabled={busy || apiKey.trim().length < MIN_API_KEY_LENGTH}>
              Save
            </Button>
          )}
          {!connection.connected && onRemove && (
            <Button type="button" variant="soft" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          )}
          {connection.connected && modelProvider && <ModelPicker provider={modelProvider} allowRoutes />}
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
    <div className="flex flex-wrap items-center gap-2">
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
          <p className="text-muted-foreground">Enter this code on the sign-in page:</p>
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
    <HarnessRow connection={connection}>
      <div className="flex flex-col gap-2">{body()}</div>
      {error && <Alert>{errorText(error)}</Alert>}
    </HarnessRow>
  )
}

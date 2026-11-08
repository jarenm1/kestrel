import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import {
  CLI_SIGN_IN,
  CliProvider,
  baseModelId,
  MODEL_PROVIDERS,

  type CliLoginStart,
  type Connection,
  type AgentModel,
  type ModelProviderInfo,
} from "@cloudagents/protocol"
import { Schema } from "effect"
import { Check, ChevronDown, Plus, RefreshCw } from "lucide-react"
import { isRouteModel, modelDisplayName } from "@cloudagents/composer/models"
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

import { setShownModels, storedShownModels, useShownModels } from "@/hooks/useShownModels"
import { useModelCatalog } from "@/hooks/useModelCatalog"
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
  "devin-cli": "Use your own Devin account through Devin CLI.",
}

/** Key-based CLI logins belong with API keys, but keep their box-local authentication. */
function isApiKeyConnection(connection: Connection) {
  return connection.kind === "apikey" ||
    (connection.kind === "cli" && Schema.is(CliProvider)(connection.provider) && CLI_SIGN_IN[connection.provider] === "key")
}

/** Model subscriptions, installed harnesses, and API keys with their chat model preferences. */
export function Connections() {
  const connections = useQuery(queries.connections())
  const catalog = useModelCatalog()
  const list = connections.data

  return (
    <>
      {connections.error && <Alert>{errorText(connections.error)}</Alert>}
      {catalog.isError && (
        <Alert>
          {catalog.isFallback
            ? "Model discovery is unavailable; showing the built-in catalog. "
            : "The last model refresh failed; showing the catalog read earlier. "}
          {errorText(catalog.error)}
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold tracking-tight">Harnesses/Subscriptions</h2>
          <Button
            variant="soft"
            size="sm"
            disabled={!catalog.canRefresh}
            onClick={catalog.refresh}
            aria-label="Refresh the models each provider offers"
          >
            <RefreshCw className={catalog.isRefreshing ? "animate-spin" : undefined} />
            {catalog.isRefreshing ? "Refreshing…" : "Refresh models"}
          </Button>
        </div>
        {connections.isPending && <div className="text-muted-foreground">Loading…</div>}
        {list && (
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
        )}
      </div>
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
      {/* The model picker makes the header taller than its label, so its extra height already reads as gap above the body. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <ConnectionHeader
            label={connection.label}
            connected={connection.connected}
            accountCount={connection.accounts?.length}
            expired={connection.expired === true}
          />
          {modelProvider && <ModelPicker provider={modelProvider} />}
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Height of the model list: ten items (2rem each), scrolling past that, less only when the window has less room. The
 * subtraction leaves room for the label, discovery status, search box and footer; the list stays fixed for longer
 * lists so the menu keeps its size while searching, and shorter lists take their own height.
 */
const MODEL_LIST_ROWS = 10
const MODEL_LIST_HEIGHT = "min(20rem, calc(var(--radix-dropdown-menu-content-available-height) - 9rem))"

/**
 * Toggles which of the provider's models the chat's model picker offers, with a search box over the list. Routes appear
 * under the harness they run; a subscription row may only pick its native models, and a route the selected box cannot
 * launch is not offered at all. The models come from the active box's runtime catalog.
 */
function ModelPicker({ provider }: { provider: ModelProviderInfo }) {
  const discovery = useModelCatalog()
  // Visibility is per model, not per route: one toggle covers every harness the model supports.
  const catalog = discovery.models.filter((model) => model.provider === provider.id && !isRouteModel(model))
  const shown = useShownModels()[provider.id]
  const chosen = storedShownModels(provider.id)
  const shownBase = new Set(shown.map((m) => baseModelId(m.id)))
  const shownCount = catalog.filter((m) => shownBase.has(m.id)).length
  const menu = useFilterMenu(
    catalog,
    (m) => `${modelDisplayName(m)} ${m.name} ${m.id}`,
    (m) => toggle(m.id, !shownBase.has(m.id)),
    { keepOpen: true },
  )

  function toggle(id: AgentModel, on: boolean) {
    // Keep ids the current catalog does not offer (an offline box, an unsupported source) until they are toggled off.
    const next = new Set((chosen ?? shown.map((m) => baseModelId(m.id))).map(baseModelId))
    if (on) next.add(id)
    else next.delete(id)
    const offered = catalog.filter((m) => next.has(m.id)).map((m) => m.id)
    const kept = [...next].filter((candidate) => !catalog.some((m) => baseModelId(m.id) === candidate))
    // Store base ids only; the chat picker expands each one to its supported routes.
    setShownModels(provider.id, [...offered, ...kept])
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
          {shownCount} of {catalog.length} shown
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
          style={catalog.length > MODEL_LIST_ROWS ? { height: MODEL_LIST_HEIGHT } : { maxHeight: MODEL_LIST_HEIGHT }}
        >
          {menu.matches.map((m) => (
            <DropdownMenuCheckboxItem
              key={m.id}
              checked={shownBase.has(m.id)}
              // Keeps the menu open so several models can be toggled in one go.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => toggle(m.id, on)}
              {...filterItemProps}
            >
              <span className="min-w-0 flex-1 truncate">{modelDisplayName(m)}</span>
            </DropdownMenuCheckboxItem>
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
      {keyProvider && !connection.available ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground">{connection.error ?? "Agent box is offline."}</p>
          <Button variant="soft" onClick={onSuccess}>Check again</Button>
          {connection.connected && modelProvider && <ModelPicker provider={modelProvider} />}
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
          {connection.connected && modelProvider && <ModelPicker provider={modelProvider} />}
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
  accountCount,
  expired = false,
}: {
  label: string
  connected: boolean
  account?: string | null
  accountCount?: number
  expired?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <strong>{label}</strong>
      {expired ? (
        <Badge variant="warning">expired</Badge>
      ) : (
        <Badge variant={connected ? "success" : "neutral"}>
          {connected
            ? accountCount !== undefined && accountCount > 1
              ? `${accountCount} connected`
              : "connected"
            : "not connected"}
        </Badge>
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
  const connections = queryClient.invalidateQueries({ queryKey: keys.connections })
  void queryClient.invalidateQueries({ queryKey: keys.allModels })
  void queryClient.invalidateQueries({ queryKey: keys.usage })
  void queryClient.invalidateQueries({ queryKey: keys.providerUsage })
  void queryClient.invalidateQueries({ queryKey: keys.usageActivity })
  return connections
}

/**
 * The active login, plus the number of other signed-in accounts when there are several, e.g.
 * "Signed in as name@example.com +2 more". Older boxes report only `connection.account`.
 */
function accountDescription(
  connection: Connection,
  accounts: readonly { id: string; account: string | null }[],
  activeAccountId: string | undefined,
): string {
  const account = accounts.find((candidate) => candidate.id === activeAccountId)?.account
    ?? connection.account
  const others = accounts.length - 1
  return `${account ? `Signed in as ${account}` : "Signed in"}${others > 0 ? ` +${others} more` : ""}`
}

/** Subscription logins of the official CLIs. The sign-in runs on the agent box; this page only relays the provider's own steps. */
function CliConnectionRow({ connection, provider }: { connection: Connection; provider: CliProvider }) {
  const queryClient = useQueryClient()
  const [login, setLogin] = useState<CliLoginStart | null>(null)
  const [loginOrigin, setLoginOrigin] = useState({ connected: false, account: null as string | null })
  const [expired, setExpired] = useState(false)
  const [code, setCode] = useState("")
  const refresh = () => invalidateConnections(queryClient)
  // Older boxes report one login without the account list; keep its Disconnect menu working.
  const accounts: readonly { id: string; account: string | null }[] = connection.accounts?.length
    ? connection.accounts
    : connection.connected
      ? [{ id: connection.activeAccountId ?? "default", account: connection.account }]
      : []
  const activeAccountId = connection.activeAccountId
    ?? accounts.find((account) => account.account === connection.account)?.id
    ?? accounts[0]?.id
  const description = accountDescription(connection, accounts, activeAccountId)
  // The account a sign-in is adding; another login may already keep the connection connected.
  const pendingAccountId = login?.accountId
  const completed = login !== null && (pendingAccountId === undefined
    ? connection.connected && (!loginOrigin.connected || connection.account !== loginOrigin.account)
    : connection.accounts?.some((account) => account.id === pendingAccountId) === true)

  const start = useMutation({
    mutationFn: () => api.cliLoginStart(provider),
    // Older boxes have no attempt id: an unchanged existing login is not completion of this attempt.
    onMutate: () => setLoginOrigin({ connected: connection.connected, account: connection.account }),
    onSuccess: (next) => {
      submitCode.reset()
      logout.reset()
      select.reset()
      cancelLogin.reset()
      setLogin(next)
      setExpired(false)
      setCode("")
    },
  })
  const submitCode = useMutation({
    mutationFn: (value: string) =>
      api.cliLoginCode(provider, {
        code: value,
        ...(pendingAccountId === undefined ? {} : { accountId: pendingAccountId }),
      }),
    onSuccess: (status) => {
      // Keep the pending sign-in unless the box confirms it took; the user can retry or cancel.
      const done = pendingAccountId === undefined
        ? status.loggedIn
        : status.accounts?.some((account) => account.id === pendingAccountId) === true
      if (done) {
        setLogin(null)
        setCode("")
      }
      refresh()
    },
  })
  const logout = useMutation({
    mutationFn: (accountId?: string) => api.cliLogout(provider, accountId),
    onSuccess: () => {
      setLogin(null)
      refresh()
    },
  })
  const select = useMutation({
    mutationFn: (accountId: string) => api.cliSelectAccount(provider, accountId),
    onSuccess: () => refresh(),
  })
  // Backing out must stop the CLI on the box too; otherwise it could finish and add the account after the cancel.
  const cancelLogin = useMutation({
    mutationFn: () => api.cliLoginCancel(provider),
    onSuccess: () => refresh(),
  })
  const busy = start.isPending || submitCode.isPending || logout.isPending || select.isPending
  const error = start.error ?? submitCode.error ?? logout.error ?? select.error ?? cancelLogin.error

  // The pending account appearing in the box's list is the completion signal, which a second account never blurs.
  useEffect(() => {
    if (!completed) return
    setLogin(null)
    setCode("")
  }, [completed])

  useEffect(() => {
    if (!login) return
    const id = setTimeout(() => setExpired(true), Math.max(0, Date.parse(login.expiresAt) - Date.now()))
    return () => clearTimeout(id)
  }, [login])

  // A device-code sign-in finishes on the provider's page, so only a re-read shows it.
  const polling = login !== null && !login.needsCode && !expired && !completed
  useEffect(() => {
    if (!polling) return
    const id = setInterval(() => invalidateConnections(queryClient), CLI_POLL_MS)
    return () => clearInterval(id)
  }, [polling, queryClient])

  function cancel() {
    cancelLogin.mutate()
    start.reset()
    submitCode.reset()
    logout.reset()
    select.reset()
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
    if (login && expired) {
      return (
        <>
          <p className="text-muted-foreground">This sign-in expired.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-fit" disabled={busy} onClick={() => start.mutate()}>
              Try again
            </Button>
            {connection.connected && (
              <Button variant="soft" className="w-fit" onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>
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
    if (connection.connected) {
      return (
        <>
          {accounts.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Switch account"
                  disabled={busy}
                  className="flex w-fit items-center gap-1 text-left text-muted-foreground hover:text-foreground"
                >
                  {description}
                  <ChevronDown className="size-3 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {accounts.map((account, index) => (
                  <DropdownMenuItem
                    key={account.id}
                    disabled={busy || account.id === activeAccountId}
                    onSelect={() => select.mutate(account.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {account.account ?? `Account ${index + 1}`}
                    </span>
                    {account.id === activeAccountId && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <p className="text-muted-foreground">
              {description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="soft" className="w-fit" disabled={busy}>
                  Disconnect
                  <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {accounts.map((account, index) => (
                  <DropdownMenuItem
                    key={account.id}
                    onSelect={() => {
                      if (window.confirm("Disconnect this subscription? Agent runs will stop using it.")) {
                        logout.mutate(account.id)
                      }
                    }}
                  >
                    {account.account ?? `Account ${index + 1}`}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="soft"
              size="icon"
              disabled={busy}
              aria-label="Sign in to another account"
              onClick={() => start.mutate()}
            >
              <Plus />
            </Button>
          </div>
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
      <div className="flex flex-col gap-3">{body()}</div>
      {error && <Alert>{errorText(error)}</Alert>}
    </HarnessRow>
  )
}

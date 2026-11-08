# Agent harnesses

A thread's model selection includes its provider and harness. The same API-key model can appear under more than
one harness in the picker; its provider still determines whose key and quota the run uses. There is no separate
per-thread harness picker. OMP, Pi and Hermes remain retired.

## Harness compatibility

| Connection | Supported harnesses |
|---|---|
| Anthropic API key | Claude Code, OpenCode |
| OpenAI API key | Codex, OpenCode |
| OpenRouter, Z.ai, DeepSeek, MiniMax API key | Claude Code, Codex, OpenCode |
| Moonshot Platform API key | Claude Code, OpenCode; Codex for K3.1 Pro, K3.1 Pro Highspeed and K3 |
| OpenCode Go key | OpenCode, Claude Code, Codex |
| Claude / ChatGPT subscription | Its own native CLI only |
| OpenCode free / Google sign-in | OpenCode / Antigravity respectively |
| Devin account | Devin CLI |

Only routes supported by the selected box and the connected credential are offered. Selecting an API provider
under another harness does not authorize that harness to use a Claude or ChatGPT subscription.
Antigravity exposes no custom-provider integration. OpenCode explicitly restricts its free-tier models to OpenCode
itself. Kimi K2.7 Code is not supported by Moonshot's Responses endpoint and therefore has no Codex route.
Z.ai's [key classification and billing rules](https://docs.z.ai/devpack/notice/api-key-management) still apply:
the Messages, Coding Chat and general Responses endpoints used here preserve its documented key/plan billing.
FlashX remains unavailable to Coding Plan keys even when its harness route is offered.

Existing model IDs keep their original harness. Additional catalog IDs append `@opencode`, `@codex` or
`@claude`; the suffix identifies Kestrel's route and is never sent as part of the upstream model name.
Claude Code's `[1m]` hint is likewise removed for native API model IDs in the other harnesses.
Routes run in OpenCode through its custom-provider API, which does not forward a selected thinking level to the
provider; those models therefore offer no thinking picker rather than silently running at OpenCode's default.
Claude Code and Codex routes keep the levels their provider documents.

Compatibility sources: [OpenCode providers](https://opencode.ai/docs/providers/),
[OpenRouter Codex](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli),
[Z.ai Codex](https://docs.z.ai/devpack/tool/codex),
[DeepSeek Codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/),
[MiniMax Codex](https://platform.minimax.io/docs/m-plan/codex),
[Kimi Codex and supported Responses models](https://platform.kimi.ai/docs/guide/codex-kimi), and
[OpenCode Console harnesses and Go endpoints](https://opencode.ai/docs/console/harnesses/).

## Credentials and sessions

- Claude Code and Codex use their connected API keys through Kestrel's credential broker, or the user's corresponding
  CLI login. Gateway runs use only their selected provider's broker route, not the user's Claude or ChatGPT login.
- OpenCode's free models require an OpenCode Console sign-in. Its tokens and sessions live in the user's `opencode`
  data directory on the box, not in the Hub or browser.
- OpenCode Go keeps its saved key in its own box-local credential directory. Its native OpenCode route mounts
  that directory; Claude Code and Codex routes use a host-side broker and do not mount the Go credential.
- Free OpenCode, native Go and Google runs receive MCP-only run tokens. Other API-key routes receive broker
  grants scoped to the selected provider, with real upstream keys remaining on the host.
- OpenCode Go requests retain session headers and carry a stable session identity and identifying user agent,
  as required by [Go's client policy](https://opencode.ai/docs/console/go/#where-can-i-use-it).
- Google runs use the user's Antigravity login, not a Google API key. Its directory contains the sign-in token and sessions.
- Devin runs use the user's Devin CLI login (`devin/credentials.toml` under its own `XDG_DATA_HOME`). `devin acp` cannot
  resume a session, so each Devin run starts a new one carrying the thread's saved conversation.
- Native sessions are isolated by both provider and harness. Switching harnesses cannot resume the other
  harness's session; returning to a route can resume its own usable session.
- CLI login directories carry a persistent `.kestrel-session-generation` marker. Native sessions are resumed only
  within that directory generation. Disconnect deletes the marker with the database; reconnecting at the same path
  starts a fresh native session with the thread's saved conversation, rather than resuming a deleted session ID.
  Older unversioned CLI-login records also replay the saved conversation once.

Page-based subscription sign-ins support multiple accounts per provider. In Connections, **+** repeats the provider's
normal sign-in in a fresh login home; the signed-in identity menu selects the account for subsequent runs, model
discovery and quota reads. Switching does not change a run already in progress. **Disconnect** lists the accounts
and removes only the chosen login. The status pill reads **N connected** only above one account. API-key rows remain
single-key connections. This follows [T3 Code's explicit account-switching approach](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-codex.md#use-multiple-accounts),
without automatic quota rotation. **Cancel** stops the pending sign-in on the box as well as clearing the form, so an
approval completed on the provider's page afterwards cannot silently add an account.

Each new page sign-in has its own HOME at `<dataDir>/users/<login>/accounts/<accountId>` and its provider's
credential/session directory beneath it. Existing logins stay in the legacy paths below as account `default`;
credentials are never copied between accounts. The owner-only `.kestrel-cli-auth.json` in the user's root persists
the selected account per provider. A different login directory starts a fresh native session with the thread's
saved conversation rather than attempting to resume another account's session. An unfinished attempt is marked and
never listed as a login; a canceled, expired or failed attempt is removed with its home, and a box restart sweeps any
left behind so later status reads do not probe them. Sandboxed CLI runs for `default` bind the user root but replace
its `accounts` subtree with an empty writable directory, so one login's processes can never read or write another
login; an isolated account's run binds only that account's home.


## Third-party model coverage

The selected box's runtime catalog drives desktop, phone and delegation model lists. Settings › Connections
includes **Refresh models**; mounted clients also poll hourly. Model toggle menus show only the models and controls,
not source diagnostics. `GET /api/models` includes source results and check times for API diagnostics.
The box caches discovery for one hour per user and credential/login identity. Connecting, replacing or removing
a credential invalidates the client catalog, and an explicit refresh bypasses the box cache. Keys stay on the host.

| Connection | Discovery source |
|---|---|
| Anthropic API | Paginated Anthropic Models API |
| OpenAI API | OpenAI Models API, restricted to modern GPT/o-series and Codex text-model families |
| OpenRouter API | OpenRouter Models API, restricted to tool-capable Anthropic text models; batch-only variants excluded |
| Z.ai API | Best-effort Coding Plan `/models` endpoint (undocumented) |
| DeepSeek, MiniMax, Moonshot API | Each provider's Models API, with non-text/incompatible models filtered |
| Claude subscription | Claude Code's stream-json initialize model list |
| ChatGPT subscription | Codex app-server's paginated `model/list` |
| OpenCode free / Go | The installed CLI's native model catalog in the corresponding login home |
| Google / Devin | ACP session model options, without starting a model turn |

Claude/ChatGPT subscription logins take precedence over their API keys for native runs, so discovery uses the
subscription's list rather than advertising API-only models through that login. A CLI that is not installed, or is
too old to sign in, rules out a subscription instead: its provider's API models stay listed and the native source
says the CLI is absent. Only a status probe that actually failed leaves the login state unknown and withholds the
API-only models. Lists describe provider/CLI availability, not a guarantee of quota, credits, regional access or
inference success. Missing credentials, unsupported installed CLI versions and failed sources have explicit API
statuses. One source failing does not discard the other sources; the curated catalog remains available when
discovery or the box is unavailable. Source errors never include upstream response bodies, tokens or local
credential paths.

Known models retain the compatibility metadata and routes in `packages/protocol/src/models.ts`.
New models use stable `live/<provider>/<upstream-id>` identities, run only through that provider's native harness,
and expose no inferred thinking levels or alternate harness routes. These identities survive saved threads,
automations and delegation without a process-global, per-user catalog registry. Compatibility metadata still
requires review when adding effort levels, context hints or cross-harness routes; enumeration does not prove them.
A runtime model's display name is derived from its own id (`anthropic/claude-opus-4-5` is **Claude Opus 4.5**,
`gpt-5.6-sol` is **GPT-5.6 Sol**). It is deterministic, so a picker entry and a saved model mention agree on the name
without a fetched catalog; the protocol id is never shown in the picker.

Visibility is per model: enabling a model enables every curated harness route it supports. New models appear by
default only while the provider follows its defaults. A saved custom visibility list is not expanded automatically;
enable additional models or use **Reset to defaults**. Temporarily missing models remain in saved lists.
The `[1m]` suffix is a Claude Code context hint, not a separate upstream model version.

Discovery references: [Anthropic](https://platform.claude.com/docs/en/api/models/list),
[OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list),
[OpenRouter variants](https://openrouter.ai/docs/guides/routing/model-variants/overview),
[DeepSeek](https://api-docs.deepseek.com/api/list-models/),
[MiniMax](https://platform.minimax.io/docs/api-reference/models/openai/list-models),
[Moonshot](https://platform.moonshot.ai/docs/api/list-models),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) and
[Codex app-server](https://developers.openai.com/codex/app-server).

Coverage checked against provider documentation on November 4, 2026:

| Provider | Curated models | Notes |
|---|---|---|
| DeepSeek | V4.1 Flash 1017; V4 Pro 0813 | `deepseek-flash` already serves V4.1 Flash 1017. Keep the live API alias rather than inventing a dated API ID. Both models show by default. |
| Z.ai | GLM-5.3; GLM-5.3 Flash; GLM-5.3 FlashX; GLM-5.2 | The first two show by default. FlashX is a standard model API option, not currently included in the GLM Coding Plan. |
| MiniMax | M3.1 Flash; M3 | Both show by default. The current Anthropic-compatible endpoint only advertises these two models; M3 has no documented effort scale. |
| Kimi (Moonshot AI) | K3.1 Pro; K3.1 Pro Highspeed; K3; K2.7 Code | The two K3.1 variants show by default and have 1M compaction windows. K2.7 Code remains opt-in for existing users; unavailable to accounts registered from November 1 and expected to retire in late December 2026. |

Z.ai and Kimi expose the documented Low / High / Max effort scale; Kimi does not advertise Medium. Z.ai defaults
to Max when no supported effort was chosen, including legacy Default selections and runs with no explicit level;
explicit supported user, run and device choices still win. Slider options remain ordered Low / High / Max.
MiniMax M3.1 Flash retains Low / Medium / High / Extra high / Max. DeepSeek retains its supported effort mapping.
Legacy DeepSeek Flash IDs route to the current Flash model, so they are not separate picker entries.
Kimi Code membership credentials remain unsupported; use a Moonshot Platform API key.

Sources: [DeepSeek models and alias mapping](https://api-docs.deepseek.com/quick_start/pricing),
[Z.ai Flash/FlashX](https://docs.z.ai/guides/vlm/glm-5.3-flash),
[GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2),
[Z.ai Claude Code effort mapping](https://docs.z.ai/devpack/latest-model),
[MiniMax Anthropic compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api),
[Kimi model availability](https://platform.kimi.ai/docs/models) and
[Kimi Messages API](https://platform.kimi.ai/docs/api/messages).

## On the box

Install the CLI on the box user's PATH (sandboxed runs use the box's Nix/toolkit PATH).

| Provider | Required CLI | Login/session storage | Command override |
|---|---|---|---|
| OpenCode free | OpenCode 2.0.7+ (`npm i -g @opencode/cli`) | `<dataDir>/users/<login>/opencode`, isolated from Go | `CLOUDAGENTS_OPENCODE_COMMAND` |
| OpenCode Go | OpenCode 2.1+ | `<dataDir>/users/<login>/opencode-go`, isolated from free models | `CLOUDAGENTS_OPENCODE_GO_COMMAND` (native route), `CLOUDAGENTS_OPENCODE_COMMAND` (`@claude`/`@codex`) |
| API providers in OpenCode | OpenCode 2.1+ | Thread-local sessions; broker token only | `CLOUDAGENTS_OPENCODE_COMMAND` |
| Codex routes (`@codex`) | Codex CLI on PATH | Thread-local sessions; broker token only | `CLOUDAGENTS_CODEX_COMMAND` (native OpenAI runs keep `CLOUDAGENTS_OPENAI_COMMAND`) |
| Google | Antigravity CLI 1.5+ (`agy`, pinned by the flake) | `<dataDir>/users/<login>/antigravity` | `CLOUDAGENTS_GOOGLE_COMMAND` |
| Devin | Devin CLI (`devin`, pinned by the flake; `curl -fsSL https://cli.devin.ai/install.sh \| bash`) | `<dataDir>/users/<login>/devin` | `CLOUDAGENTS_DEVIN_COMMAND` |

An OpenCode command override must not inline `OPENCODE_CONFIG_CONTENT`: the box sets that per run, and an inline
assignment shadows the generated route provider. The box warns at startup if it sees one.

`dataDir` is `CLOUDAGENTS_DATA_DIR`, or `.data` under the repository by default. `opencode-ai` and
opencode.ai/install are OpenCode 1 and do not satisfy these requirements.

Free models sign in through Settings › Connections › **OpenCode › Connect**. The box runs
`opencode auth login opencode --method device --standalone`; open the displayed OpenCode link and enter its device
code. Kestrel polls the box until authorization completes. Installation alone does not connect the models.
Disconnect removes only the selected login directory and its sessions, without touching other Console accounts or
the separate Go connection.
See [OpenCode authentication](https://opencode.ai/v2/docs/cli/providers).

Go signs in through Settings › Connections › **API keys**: choose **Add API key › OpenCode Go**.
Its connected row supports replacing the key and choosing which Go models appear in chat; Go is not listed again
under Accounts and subscriptions or Models. Its native route uses OpenCode ACP; alternate Claude Code and Codex
routes use the same box-local credential through the broker. The box passes the key to
`opencode auth import --standalone` over stdin, not argv or Hub storage. Replacing the named credential preserves
sessions; Disconnect removes the Go login directory. Its quota panel reports five-hour, weekly and monthly usage.
If the selected box is unavailable or has not reported Go auth, its API-key row stays visible with the error and
**Check again**. Missing auth does not imply the saved key was removed; the unavailable row is not offered again
in **Add API key**.

Google signs in through Settings › Connections: the box runs `agy acp --login --gemini-dir <dir>`, and the user sends
back the code shown by Google (or that page's URL). Antigravity 1.5 is required for terminal sign-in and `session/resume`.
The Connections row shows the signed-in Google email when agy's stored token carries one; otherwise it stays blank.

Devin signs in through Settings › Connections: the box runs `devin auth login --force-manual-token-flow` under
`script`'s pseudo-terminal (the CLI reads the code only from a terminal), and the user sends back the code shown on the
app.devin.ai page it links. The catalog offers Devin's Adaptive router and SWE-1.6 Fast, as values of `devin acp`'s
`model` session option.

## Selected-box availability and installed clients

The box reports runnable providers in `GET /api/capabilities` (`harnesses`). Both clients combine Worker-stored
connection metadata with CLI logins and capabilities from the **selected box**. A BYOB box never inherits the
managed/relay box's availability. Switching boxes resets or scopes connection caches; an unreachable box leaves
stored accounts manageable while its CLI rows become unavailable.

`GET /api/connections` reports CLI-login state for installed clients, including the OpenCode account rather than
installation-only availability. Updated clients replace this legacy box state with selected-box data.
Retired OMP/Pi/Hermes rows are not offered.

The status and usage arrays preserve installed clients' provider literals. With no `providers` query,
`GET /api/cli-auth` and `GET /api/cli-auth/usage` return the original Claude, Codex and Antigravity providers where
supported, never Go or OpenCode Console. Updated clients advertise the catalog they can decode through
`ControlPaths.cliAuthFor(CliProvider.literals)` and `cliUsageFor(CliProvider.literals)`. The box returns only advertised
providers, keeping new logins available without breaking an older decoder.

CLI status and connection rows include `accounts: [{ id, account }]` and `activeAccountId` when accounts are connected;
the existing `loggedIn`/`connected` and `account` fields describe the active login. `POST /api/cli-auth/:provider/login`
returns the new pending `accountId`; send it with the pasted `code` to `POST /api/cli-auth/:provider/code`, and
`POST /api/cli-auth/:provider/login/cancel` stops a pending sign-in and removes its unfinished home.
`POST /api/cli-auth/:provider/account` with `{ accountId }` selects a connected login.
`DELETE /api/cli-auth/:provider?accountId=<id>` disconnects one login; omitting the id targets the active login.


- Capability probes use the configured `CLOUDAGENTS_*_COMMAND`, including native-binary overrides and minimum versions.
- Each ACP launch rechecks only its selected provider's command/version, so a removed or downgraded CLI fails before launch.
- With `CLOUDAGENTS_FAKE_AGENT=1`, the scripted agent supports Anthropic, OpenAI, free OpenCode, Go, Google and Devin; other
  provider commands are unavailable in that mode.

The ACP driver remains shared in `packages/server/src/core/acp.ts`; transcript items are decoded in `core/transcript.ts`.

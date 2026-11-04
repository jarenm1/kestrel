# Agent harnesses

A thread's model selects its provider's CLI: Claude Code for Anthropic and Anthropic-compatible gateways, Codex for
OpenAI, OpenCode for its free and Go models, and Antigravity CLI for Google. There is no separate per-thread harness
picker. OMP, Pi and Hermes are retired; see [the scope decision and historical-state migration](architecture.md#agent-execution-and-data).

## Credentials and sessions

- Claude Code and Codex use their connected API keys through Kestrel's credential broker, or the user's corresponding
  CLI login. Gateway runs use only their selected provider's broker route, not the user's Claude or ChatGPT login.
- OpenCode's free models need no connection, Go key or vendor broker credential. Their sessions live in the thread home.
- OpenCode Go uses its own saved key and credential/session directory. Only a Go run mounts that directory and receives
  its `XDG_DATA_HOME`; native vendor, Google and free OpenCode runs do not receive the Go login.
- Free OpenCode, Go and Google runs receive MCP-only run tokens: no vendor broker environment and no vendor-authorized
  broker grant. Go and free OpenCode keep separate sessions.
- Google runs use the user's Antigravity login, not a Google API key. Its directory contains the sign-in token and sessions.
- Session records retain their actual model provider, even when multiple providers run Claude Code. Switching providers
  cannot resume another provider's session; returning to a provider can resume its own usable session.

## Third-party model coverage

The shared catalog in `packages/protocol/src/models.ts` drives desktop and mobile model lists. Settings ›
Connections exposes the full curated list; chat initially shows current flagship/fast choices. A saved custom
list remains unchanged when the catalog grows; select additional models there or use **Reset to defaults**.
The `[1m]` suffix is a Claude Code context hint, not a separate upstream model version.

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
| OpenCode free | OpenCode 2.0+ (`npm i -g @opencode/cli`) | thread home, no key | `CLOUDAGENTS_OPENCODE_COMMAND` |
| OpenCode Go | OpenCode 2.1+ | `<dataDir>/users/<login>/opencode-go`, isolated from free models | `CLOUDAGENTS_OPENCODE_GO_COMMAND` |
| Google | Antigravity CLI 1.5+ (`agy`, pinned by the flake) | `<dataDir>/users/<login>/antigravity` | `CLOUDAGENTS_GOOGLE_COMMAND` |

`dataDir` is `CLOUDAGENTS_DATA_DIR`, or `.data` under the repository by default. `opencode-ai` and
opencode.ai/install are OpenCode 1 and do not satisfy these requirements.

Go signs in through Settings › Connections using its password-key form. The box passes the key to
`opencode auth import --standalone` over stdin, not argv or Hub storage. Replacing the named credential preserves
sessions; Disconnect removes the Go login directory. Its quota panel reports five-hour, weekly and monthly usage.

Google signs in through Settings › Connections: the box runs `agy acp --login --gemini-dir <dir>`, and the user sends
back the code shown by Google (or that page's URL). Antigravity 1.5 is required for terminal sign-in and `session/resume`.

## Selected-box availability and installed clients

The box reports runnable providers in `GET /api/capabilities` (`harnesses`). Both clients combine Worker-stored
connection metadata with CLI logins and capabilities from the **selected box**. A BYOB box never inherits the
managed/relay box's availability. Switching boxes resets or scopes connection caches; an unreachable box leaves
stored accounts manageable while its CLI rows become unavailable.

`GET /api/connections` retains native CLI-login state and free OpenCode availability for installed clients. Updated
clients replace this legacy box state with selected-box data. Retired OMP/Pi/Hermes rows are not offered.

The status and usage arrays preserve installed clients' provider literals. With no `providers` query,
`GET /api/cli-auth` and `GET /api/cli-auth/usage` return the pre-Go providers where supported, never Go—even when a Go
key is configured. Updated clients advertise the catalog they can decode through
`ControlPaths.cliAuthFor(CliProvider.literals)` and `cliUsageFor(CliProvider.literals)`. The box returns only advertised
providers, keeping Go status/quotas available without breaking an older decoder.

- Capability probes use the configured `CLOUDAGENTS_*_COMMAND`, including native-binary overrides and minimum versions.
- Each ACP launch rechecks only its selected provider's command/version, so a removed or downgraded CLI fails before launch.
- With `CLOUDAGENTS_FAKE_AGENT=1`, the scripted agent supports Anthropic, OpenAI, free OpenCode, Go and Google; other
  provider commands are unavailable in that mode.

The ACP driver remains shared in `packages/server/src/core/acp.ts`; transcript items are decoded in `core/transcript.ts`.

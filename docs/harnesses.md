# Agent harnesses

A thread's model picks the harness. Claude Code (`anthropic`, plus the Anthropic-compatible gateways) and Codex
(`openai`) are vendor CLIs. Antigravity CLI (`google`) speaks the Agent Client Protocol and reaches Gemini only through
the user's Google sign-in. OpenCode, OMP, Pi and Hermes are **standalone ACP harnesses**: their own CLI speaks ACP over
stdio, so the box must have that CLI before the harness can run there.

The model picker groups models by provider, so choosing **Antigravity**, **OpenCode**, **OMP**, **Pi** or **Hermes** is
choosing the harness. OMP, Pi and Hermes each have one catalog entry that means "the model configured in that CLI"; the
harness's own `/model` command changes it. OpenCode's entry is one of its free models, which need no sign-in;
Antigravity's entry is Gemini, run on the signed-in Google account.

## Credentials: the broker, not the sandbox

A standalone harness's model calls go through Kestrel's credential broker, exactly like a vendor CLI's do (OpenCode's
own free models are the exception, described below):

- Each run gets its own broker token, in the standard environment a CLI already reads: `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_API_KEY` and `OPENAI_BASE_URL` + `OPENAI_API_KEY`. The token is scoped to the run, revoked when the run
  ends, and only reaches the user's own connection keys from Settings › Connections.
- **No credential file enters the sandbox.** Kestrel never mounts a harness's login from the operator's home
  (`~/.omp`, `~/.pi`, `~/.hermes`) into a run. The only harness directory a run mounts is the per-user **harness home**
  below, which holds settings and sessions, not keys.
- A harness that insists on a key of its own cannot have one here: connect the provider in Settings › Connections and
  point the harness at the broker environment variables, or override its command (`CLOUDAGENTS_OMP_COMMAND`, …) to do
  so.
- OpenCode is the exception: it runs its own free models, so its runs get no broker keys and no broker access at all
  (only the run's MCP token). Its models need no connection.
- Antigravity is the other exception: Gemini is reached only through the user's Google sign-in, so a Google run gets no
  broker keys and mounts that user's Antigravity login directory (`antigravity`), whose token is the credential. Its
  `AGENT_CLIS` entry has no status or sign-out command (Kestrel reads the token file and signs out by removing the
  directory) and no probe, so the composer lists no Google commands.

## On the box

Install the CLI where a run starts it: on the box user's PATH (the run's PATH for sandboxed runs is the box's
Nix/toolkit PATH).

| Harness | Install | Harness home (mounted into the run) | Config inside the run |
|---|---|---|---|
| Antigravity | Antigravity CLI 1.5+ as `agy` (the flake pins it) | the user's CLI login directory `<dataDir>/users/<login>/antigravity` | `$AGY_GEMINI_DIR` |
| OpenCode | `npm i -g @opencode/cli` (OpenCode 2) | none: sessions live in the thread's own home | none: `OPENCODE_CONFIG_CONTENT` |
| OMP | install from the OMP distribution (`omp` on PATH) | `<dataDir>/users/<login>/harnesses/omp` | `~/.omp` |
| Pi | `npm install -g @earendil-works/pi-coding-agent pi-acp` | `<dataDir>/users/<login>/harnesses/pi` | `~/.pi` |
| Hermes | `npm install -g hermes-agent && hermes-npm setup` | `<dataDir>/users/<login>/harnesses/hermes` | `~/.hermes` |

`dataDir` is `CLOUDAGENTS_DATA_DIR`, or `.data` under the repository in development. Kestrel creates the harness home
(owner-only) and binds it read-write at the harness's config path in the run, so settings and the session store survive
between runs of that user.

To set the harness up, run its own setup **with `HOME` pointed at the harness home**, so it writes where the run reads:

```sh
# OMP, on the box, as the box user; <login> is the Kestrel account
HOME="$CLOUDAGENTS_DATA_DIR/users/<login>/harnesses/omp" omp login <provider>
# Hermes
HOME="$CLOUDAGENTS_DATA_DIR/users/<login>/harnesses/hermes" hermes setup
```

Any setup that writes a **credential** must be kept out of that directory (it is mounted into every run). Use a
provider connected in Settings › Connections instead.

`pi-acp` is the ACP adapter Kestrel launches. OMP speaks ACP natively (`omp acp`); Hermes uses `hermes acp`; OpenCode
runs `opencode acp`; Antigravity runs `agy acp --gemini-dir "$AGY_GEMINI_DIR"`. Override the commands on the box with
`CLOUDAGENTS_OPENCODE_COMMAND`, `CLOUDAGENTS_GOOGLE_COMMAND`, `CLOUDAGENTS_OMP_COMMAND`, `CLOUDAGENTS_PI_COMMAND` and
`CLOUDAGENTS_HERMES_COMMAND`.

Google signs in through Settings › Connections: the box runs `agy acp --login --gemini-dir <dir>` and the user sends
back the code the Google page shows (or that page's URL). Antigravity needs version 1.5 for terminal sign-in and
`session/resume`.

## Availability: Connections is the source of truth

At startup the box reports runnable providers in `GET /api/capabilities` (`harnesses`), and standalone-harness detail
in `GET /api/harness-status` (`HarnessStatus[]`). Both apps combine Worker-stored connection metadata with CLI logins
and capabilities fetched from the **selected box**. They do not use the managed/relay box's availability for a BYOB
box. Switching boxes resets or scopes this cache; an unreachable box leaves stored accounts manageable but its
CLI/harness rows unavailable.

For installed clients, `GET /api/connections` retains its existing CLI-login state and standalone harness rows from
the managed/relay box. Updated clients replace those legacy box fields with the selected box's state; compatibility
does not make the managed box authoritative for a BYOB box.

The status and usage arrays also preserve installed clients' provider literals. With no `providers` query,
`GET /api/cli-auth` and `GET /api/cli-auth/usage` return only Claude, Codex and Antigravity entries (where supported),
never Go—even when a Go credential is configured. Updated clients advertise the catalog they can decode through
`ControlPaths.cliAuthFor(CliProvider.literals)` and `cliUsageFor(CliProvider.literals)`. The box returns only advertised
providers, so those clients retain Go status/quotas and later server-side providers cannot break an older decoder.

- The probe uses the configured `CLOUDAGENTS_*_COMMAND`, including native-binary path overrides.
- Free OpenCode requires 2.0; Go requires 2.1 and its own saved key; Antigravity requires 1.5 and its Google sign-in.
  Install OpenCode with `npm i -g @opencode/cli`; `opencode-ai` and opencode.ai/install are OpenCode 1.
- The picker offers only harnesses the selected box reports. Every ACP launch checks just that provider's configured
  binary and version again, so an uninstalled or downgraded CLI fails before starting the process.
- OpenCode's free models need no Go key or broker credential. Go mounts only its own credential/session directory
  and gets an MCP-only token, never access to the vendor broker. The two providers keep separate sessions.
- With `CLOUDAGENTS_FAKE_AGENT=1`, the scripted agent plays Anthropic, OpenAI, free OpenCode, Go and Google only;
  OpenRouter, OMP, Pi and Hermes remain unavailable.

## What works today

- Antigravity: text, thinking, tool calls, plans, usage/context and session resume work through `agy acp` 1.5, with
  the thinking level taken from its `thought_level` option. Gemini needs the user's Google sign-in, and its run gets no
  broker keys.
- OpenCode: text, thinking, tool calls, plans, usage/context and session resume (`session/resume`) work through
  `opencode acp` 2.0.6. Its free models need no connection, and its runs get no broker keys.
- OMP: text, thinking, tool calls, Kestrel MCP tools, usage/cost and session resume are implemented and exercised
  against a real OMP 18.12.6 login.
- Pi: text, thinking and session resume work through `pi-acp` 0.0.34. The adapter advertises no ACP MCP support
  (`mcpCapabilities.http: false`), so Kestrel's MCP tools are not available in Pi runs yet; Pi's own built-in tools run
  in the thread workspace.
- Hermes: provider and command are wired, but the runtime is a large one-time download; it is not installed in the
  development image. The run fails clearly until `hermes-npm setup` has completed.

## Sandbox

The harness home is bound read-write into sandboxed runs at the harness's config path under the run's home. In
`CLOUDAGENTS_SANDBOX=off` development runs it is symlinked into the task home (the run's HOME), because that home is not
the host home. The user's real home is never bound in either mode.

## Adding a harness

1. Add the provider and its default model to `packages/protocol/src/models.ts` with `harness: "acp"` and a `setup` hint.
2. Add its id to `AcpHarnessId` and its default command to `acpCommands` in `packages/server/src/config.ts`.
3. Add its entry to `MODEL_HARNESS` in `packages/server/src/agent-clis.ts`: the ACP conversation, the CLI login it runs
   under (or null), its binary, the oldest `[major, minor]` version it needs, and whether its runs get the broker's keys.
   A harness with a CLI login also gets an `AGENT_CLIS` entry (`google` runs under `antigravity-cli`).
4. If it keeps settings and sessions in a per-user directory, add that directory to `ACP_CONFIG_DIRS` in
   `packages/server/src/core/harness.ts` (OpenCode needs none: its sessions live in the thread's own home).
5. ACP itself is generic (`packages/server/src/core/acp.ts` for the transport, `core/transcript.ts` for its items); no
   new driver is needed for an ACP-speaking CLI.

# Agent harnesses

A thread's model picks the harness. Claude Code (`anthropic`, plus the Anthropic-compatible gateways) and Codex
(`openai`) are vendor CLIs. OMP, Pi and Hermes are **standalone ACP harnesses**: their own CLI speaks the Agent Client
Protocol over stdio, so the box must have that CLI before the harness can run there.

The model picker groups models by provider, so choosing **OMP**, **Pi** or **Hermes** is choosing the harness. Each has
one catalog entry that means "the model configured in that CLI"; the harness's own `/model` command changes it.

## Credentials: the broker is the only path to a model

A harness's model calls go through Kestrel's credential broker, exactly like a vendor CLI's do:

- Each run gets its own broker token, in the standard environment a CLI already reads: `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_API_KEY` and `OPENAI_BASE_URL` + `OPENAI_API_KEY`. The token is scoped to the run, revoked when the run
  ends, and only reaches the user's own connection keys from Settings › Connections.
- **No credential file enters the sandbox.** Kestrel never mounts a harness's login from the operator's home
  (`~/.omp`, `~/.pi`, `~/.hermes`) into a run. The only harness directory a run mounts is the per-user **harness home**
  below, which holds settings and sessions, not keys.
- A harness that insists on a key of its own cannot have one here: connect the provider in Settings › Connections and
  point the harness at the broker environment variables, or override its command (`CLOUDAGENTS_OMP_COMMAND`, …) to do
  so.

## On the box

Install the CLI where a run starts it: on the box user's PATH (the run's PATH for sandboxed runs is the box's
Nix/toolkit PATH).

| Harness | Install | Harness home (mounted into the run) | Config inside the run |
|---|---|---|---|
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

`pi-acp` is the ACP adapter Kestrel launches. OMP speaks ACP natively (`omp acp`); Hermes uses `hermes acp`. Override the
commands on the box with `CLOUDAGENTS_OMP_COMMAND`, `CLOUDAGENTS_PI_COMMAND` and `CLOUDAGENTS_HERMES_COMMAND`.

## Availability: Connections is the source of truth

At start the box probes the harness binaries once and serves the answer at `GET /api/harness-status`
(`HarnessStatus[]`). The relay merges it into `GET /api/connections`, one `Connection` per harness, so:

- Settings › Connections marks a harness **not installed on this box** (with the reason) instead of offering it.
- The model picker only offers a standalone harness the box reported, and a send that asks for a missing one fails with
  an actionable error (`connection-unavailable`) before any process starts.
- With `CLOUDAGENTS_FAKE_AGENT=1` the scripted agent does not speak ACP, so every harness is reported unavailable
  rather than hanging a run.

## What works today

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
3. Add its config directory to `ACP_CONFIG_DIRS` in `packages/server/src/core/harness.ts`.
4. ACP itself is generic (`packages/server/src/core/acp-driver.ts`); no new driver is needed for an ACP-speaking CLI.

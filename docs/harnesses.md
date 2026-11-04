# Agent harnesses

A thread's model picks the harness. Claude Code (`anthropic`, plus the Anthropic-compatible gateways) and Codex
(`openai`) use Kestrel's broker keys. OMP, Pi and Hermes are **standalone ACP harnesses**: their CLI owns the model
login, and the box must have that CLI configured before the model appears in the picker. Their config directories are
bound into the run's home (`~/.omp`, `~/.pi`, `~/.hermes`), and Kestrel passes its MCP server to OMP in the ACP
`session/new` request.

The model picker groups models by provider, so choosing **OMP**, **Pi** or **Hermes** is choosing the harness. Each has
one catalog entry that means "the model configured in that CLI"; the harness's own `/model` command changes it.

## On the box

Run these as the box user (the same HOME the agent runs with):

| Harness | Install | Sign in | Config |
|---|---|---|---|
| OMP | install from the OMP distribution (the `omp` binary must be on PATH) | `omp login [provider]`, or `omp auth import` | `~/.omp` |
| Pi | `npm install -g @earendil-works/pi-coding-agent pi-acp` | `pi`, then `/login`; or set a provider key in `~/.pi/agent/auth.json` | `~/.pi` |
| Hermes | `npm install -g hermes-agent && hermes-npm setup` | `hermes setup` | `~/.hermes` |

`pi-acp` is the ACP adapter Kestrel launches. OMP speaks ACP natively (`omp acp`); Hermes uses `hermes acp`. Override the
commands on the box with `CLOUDAGENTS_OMP_COMMAND`, `CLOUDAGENTS_PI_COMMAND` and `CLOUDAGENTS_HERMES_COMMAND`.

## What works today

- OMP: text, thinking, tool calls, Kestrel MCP tools, usage/cost and session resume are implemented and exercised
  against a real OMP 18.12.6 login.
- Pi: text, thinking and session resume work through `pi-acp` 0.0.34. The adapter advertises no ACP MCP support
  (`mcpCapabilities.http: false`), so Kestrel's MCP tools are not available in Pi runs yet; Pi's own built-in tools run
  in the thread workspace.
- Hermes: provider and command are wired, but the runtime is a large one-time download; it is not installed in the
  development image. The run fails clearly until `hermes-npm setup` has completed.

## Sandbox

ACP config directories are bound read-write into sandboxed runs at the same path under the sandbox home. In
`CLOUDAGENTS_SANDBOX=off` development runs the host directory is symlinked into the task home, because the run's HOME is
the task home rather than the host home. The CLI's binary must be on the run's PATH (the host PATH for unsandboxed runs,
the box's Nix/toolkit PATH for sandboxed ones).

## Adding a harness

1. Add the provider and its default model to `packages/protocol/src/models.ts` with `harness: "acp"` and a `setup` hint.
2. Add its default command to `acpCommands` in `packages/server/src/config.ts`.
3. Add its config directory to `ACP_CONFIG_DIRS` in `packages/server/src/core/harness.ts`.
4. ACP itself is generic (`packages/server/src/core/acp-driver.ts`); no new driver is needed for an ACP-speaking CLI.

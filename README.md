# Kestrel

Run your own agent harness in a sandboxed box with a live desktop.

- `packages/site`: the static marketing site (Astro + Tailwind): landing and pricing. Deployed as Worker `kestrel-site` on https://kestrel-agent.com.
- `packages/app`: the React SPA (Vite, Tailwind, shadcn/ui, TanStack Query). Talks only to the control plane, same origin.
- `packages/control`: the Cloudflare Worker control plane: GitHub sign-in, connections, and a relay to the agent box. Serves the built `packages/app` as static assets. Deployed as Worker `kestrel` on https://app.kestrel-agent.com (and its workers.dev URL, which boxes dial).
- `packages/server`: the agent box. Runs harnesses inside bubblewrap, serves the desktop and MCP, and dials out to the control plane.
- `packages/protocol`: shared schemas, including the relay frames (`relay.ts`) and control-plane API (`control.ts`).

## Local development

Needs Nix with flakes. Nothing in the cloud is required.

```sh
nix run
```

This starts (ports for uid 1000; see below):
- the Worker on http://127.0.0.1:8788 (`wrangler dev`, local Durable Object state in `packages/control/.wrangler`),
- a box on 127.0.0.1:8797 connected to that Worker (data in `.data-dev/`); 8787 is left to the production box,
- Vite on http://localhost:5173.

Open the printed URL (`/auth/dev-login`) to sign in as `dev`. The first run creates `packages/control/.dev.vars` with a random local box token.

### Shared dev machine

Several people can run `nix run` on one machine, each from their own clone under their own Linux user, and each person can run several worktrees at once. Ports are offset by `(uid - 1000) * 100 + KESTREL_DEV_SLOT * 10` (slot 0-9, default 0; `KESTREL_DEV_OFFSET` overrides the whole offset): uid 1001 slot 0 gets app 5273, Worker 8888, box 8897; slot 1 adds 10 to each. `nix run` prints the ports. From your laptop, forward the app port and open it locally:

```sh
ssh -L 5273:localhost:5273 <you>@<dev-machine>
# then open http://localhost:5273/auth/dev-login
```

Working with agents or in parallel: see [AGENTS.md](AGENTS.md) (one git worktree and one PR per change).

Agents need a model key: add one on the Connections page, or export `ANTHROPIC_API_KEY` before `nix run` (the box's broker uses it as a fallback; the sandbox only ever sees a per-run token).

### Agent sandbox

Everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits cap all of the task's processes together; swap is off for it, so the memory limit is hard and the kernel OOM-kills inside the task only.

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | systemd `MemoryMax` per task |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | systemd `CPUQuota` per task (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | systemd `TasksMax` (processes + threads) per task |
| `CLOUDAGENTS_SYSTEMD` | on | `0` runs without limits (machines without a user systemd manager) |

The box needs the user's systemd manager (`systemd-run --user`) with the memory, cpu and pids controllers delegated (the default on systemd distros). It checks this at startup and refuses to start otherwise; a box that outlives your login session (the production box) needs `loginctl enable-linger <user>`. At startup the box also stops its own slice, killing sandboxes a previous instance left behind; deleting a task stops its slice and drops its limits. Inspect live sandboxes with `systemd-cgls --user-unit kestrel.slice`.

Checks: `nix develop -c bun run typecheck`. Marketing site: `bun run dev:site` (Astro on http://localhost:4321).

## Deploys

- **App and control plane:** Workers Builds deploys `main` (build `bun run build:app`, then `wrangler deploy` in `packages/control`). To deploy by hand: `bunx cf builds create d87f7f0a-5dee-45c5-bb88-e5829c3a7792 --branch main`.
- **Marketing site:** Workers Builds deploys `main` (build `bun run build:site`, then `wrangler deploy` in `packages/site`). Links to the app use `PUBLIC_APP_URL` (default `https://app.kestrel-agent.com`).
- **GitHub sign-in** needs a GitHub OAuth app whose callback URL is `https://app.kestrel-agent.com/auth/github/callback`, with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set as secrets on Worker `kestrel`.
- **Production box:** runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

Pull requests get isolated Previews at `https://<branch>-kestrel.jarenmchugh.workers.dev` (app) and `https://<branch>-kestrel-site.jarenmchugh.workers.dev` (site), branch name with `/` replaced by `-`. The app Preview has its own empty Hub, no production secrets and no box, so it is for UI review.

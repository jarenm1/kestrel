# Kestrel

Run your own agent harness in a sandboxed box with a live desktop.

- `packages/site`: the static marketing site (Astro + Tailwind): landing and pricing. Deployed as Worker `kestrel-site` on https://kestrel-agent.com.
- `packages/app`: the React SPA (Vite, Tailwind, shadcn/ui, TanStack Query). Talks only to the control plane, same origin.
- `packages/control`: the Cloudflare Worker control plane: GitHub sign-in, connections, and a relay to the agent box. Serves the built `packages/app` as static assets. Deployed as Worker `kestrel` on https://app.kestrel-agent.com (and its workers.dev URL, which boxes dial).
- `packages/server`: the agent box. Runs harnesses inside bubblewrap, serves the desktop and MCP, and dials out to the control plane.
- `packages/protocol`: shared schemas, including the relay frames (`relay.ts`) and control-plane API (`control.ts`).

## Local development

Nothing in the cloud is required. Nix is optional: the flake is a convenience that pins the toolchain and starts the whole stack with one command.

```sh
nix run
```

This starts (ports for uid 1000; see below):
- the Worker on http://127.0.0.1:8788 (`wrangler dev`, local Durable Object state in `packages/control/.wrangler`),
- a box on 127.0.0.1:8797 connected to that Worker (data in `.data-dev/`); 8787 is left to the production box,
- Vite on http://localhost:5173.

Open the printed URL (`/auth/dev-login`) to sign in as `dev`. The first run creates `packages/control/.dev.vars` with a random local box token.

### Without Nix

Install Bun and Node 22 yourself. That is enough for the app, the control plane, the site, `bun run typecheck` and the builds. The box's desktop also needs Xvfb, openbox, xterm, xdotool and an ffmpeg built with x11grab. Then run what `nix run` would, the last three commands each in its own terminal:

```sh
bun install --frozen-lockfile
bun run build:app                      # once; the Worker serves packages/app/dist
printf 'BOX_TOKEN=%s\nDEV_SESSION_LOGIN=dev\nALLOWED_GITHUB_LOGINS=dev\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > packages/control/.dev.vars

(cd packages/control && bunx wrangler dev --port 8788 --ip 127.0.0.1)   # Worker
CLOUDAGENTS_PORT=8797 CLOUDAGENTS_DATA_DIR=$PWD/.data-dev CLOUDAGENTS_CONTROL_URL=http://127.0.0.1:8788 \
  CLOUDAGENTS_BOX_TOKEN=$(sed -n 's/^BOX_TOKEN=//p' packages/control/.dev.vars) \
  CLOUDAGENTS_SANDBOX=0 bun run dev:server                               # box; keep it off 8787
bun run dev:app                                                          # Vite on :5173
```

The agent sandbox is the one part that still depends on Nix: it exposes only `/nix/store` and a toolchain directory from it (`CLOUDAGENTS_SANDBOX_PATH`, `CLOUDAGENTS_SANDBOX_SSL`, set by the flake). Without Nix, run the box with `CLOUDAGENTS_SANDBOX=0` as above, which runs agents unsandboxed: fine for local work with the fake agent or your own key, never for a shared or production box. Add `CLOUDAGENTS_SYSTEMD=0` if you have no user systemd manager. On NixOS use the flake: the npm `workerd` binary that `bunx wrangler` runs does not start there.

### Shared dev machine

Several people can run `nix run` on one machine, each from their own clone under their own Linux user, and each person can run several worktrees at once. Ports are offset by `(uid - 1000) * 100 + KESTREL_DEV_SLOT * 10` (slot 0-9, default 0; `KESTREL_DEV_OFFSET` overrides the whole offset): uid 1001 slot 0 gets app 5273, Worker 8888, box 8897; slot 1 adds 10 to each. `nix run` prints the ports. From your laptop, forward the app port and open it locally:

```sh
ssh -L 5273:localhost:5273 <you>@<dev-machine>
# then open http://localhost:5273/auth/dev-login
```

Working with agents or in parallel: see [AGENTS.md](AGENTS.md) (one git worktree and one PR per change).

Agents need a model key: add one on the Connections page, or export `ANTHROPIC_API_KEY` before starting the box (the box's broker uses it as a fallback; the sandbox only ever sees a per-run token).

### Agent sandbox

Everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits cap all of the task's processes together; swap is off for it, so the memory limit is hard and the kernel OOM-kills inside the task only.

Each task also has its own network namespace, made by `pasta` (passt) when the task first launches something and shared by all of that task's sandboxes, so a browser on the task desktop reaches the agent's dev server on `localhost`. Outbound internet works through pasta's user-space NAT. The host's `127.0.0.1` is out of reach except the box port, which is forwarded in for the broker and MCP. Other tasks' servers and X servers that listen on abstract sockets (such as a desktop session's `:0`) are out of reach too, and the task's own servers are not published on the host. The LAN and the host's non-loopback addresses are still reachable. pasta and its holder process live in the task slice and go away with the task.

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | systemd `MemoryMax` per task |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | systemd `CPUQuota` per task (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | systemd `TasksMax` (processes + threads) per task |
| `CLOUDAGENTS_SYSTEMD` | on | `0` runs without limits (machines without a user systemd manager) |

The box needs the user's systemd manager (`systemd-run --user`) with the memory, cpu and pids controllers delegated (the default on systemd distros). It checks this at startup and refuses to start otherwise; a box that outlives your login session (the production box) needs `loginctl enable-linger <user>`. At startup the box also stops its own slice, killing sandboxes a previous instance left behind; deleting a task stops its slice and drops its limits. Inspect live sandboxes with `systemd-cgls --user-unit kestrel.slice`.

Signed-in users can instead run agents on their own Claude or ChatGPT subscription: sign in on the Connections page (the box runs the unmodified `claude auth login` / `codex login --device-auth` in that user's directory). Each user's CLI state lives only on the box under `<CLOUDAGENTS_DATA_DIR>/users/<login>/{claude,codex}`, and the box's CLI runs use their own login; the sandbox sees just the directories of the providers that user has signed in to. Those runs use the login in place of the broker's API key for that provider.

Projects are private to the user who added them: the box answers every project, task, run, diff and desktop route (REST and WebSocket) only for the project's owner and returns `404` to anyone else. The box clones with the adding user's own GitHub token, so GitHub decides which repositories someone can import, and the broker pays for a run with the keys of the user who started it. Projects saved before owners existed are dropped from the box state at startup (logged; their files stay on disk).

Checks: `bun run typecheck`. Marketing site: `bun run dev:site` (Astro on http://localhost:4321).

## Deploys

- **App and control plane:** Workers Builds deploys `main` (build `bun run build:app`, then `wrangler deploy` in `packages/control`). To deploy by hand: `bunx cf builds create d87f7f0a-5dee-45c5-bb88-e5829c3a7792 --branch main`.
- **Marketing site:** Workers Builds deploys `main` (build `bun run build:site`, then `wrangler deploy` in `packages/site`). Links to the app use `PUBLIC_APP_URL` (default `https://app.kestrel-agent.com`).
- **GitHub sign-in** needs a GitHub OAuth app whose callback URL is `https://app.kestrel-agent.com/auth/github/callback`, with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set as secrets on Worker `kestrel`.
- **Production box:** runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

Pull requests get isolated Previews at `https://<branch>-kestrel.jarenmchugh.workers.dev` (app) and `https://<branch>-kestrel-site.jarenmchugh.workers.dev` (site), branch name with `/` replaced by `-`. The app Preview has its own empty Hub, no production secrets and no box, so it is for UI review.

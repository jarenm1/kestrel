# Kestrel

Run your own agent harness in a sandboxed box with a live desktop.

- `packages/app`: the React SPA (Vite, Tailwind, shadcn/ui, TanStack Query). Talks only to the control plane, same origin.
- `packages/control`: the Cloudflare Worker control plane: GitHub sign-in, connections, and a relay to the agent box. Serves the built `packages/app` as static assets. Deployed as Worker `kestrel`.
- `packages/server`: the agent box. Runs harnesses inside bubblewrap, serves the desktop and MCP, and dials out to the control plane.
- `packages/protocol`: shared schemas, including the relay frames (`relay.ts`) and control-plane API (`control.ts`).

## Local development

Needs Nix with flakes. Nothing in the cloud is required.

```sh
nix run
```

This starts:
- the Worker on http://127.0.0.1:8788 (`wrangler dev`, local Durable Object state in `packages/control/.wrangler`),
- a box on 127.0.0.1:8787 connected to that Worker (data in `.data-dev/`),
- Vite on http://localhost:5173.

Open http://localhost:5173/auth/dev-login to sign in as `dev`. The first run creates `packages/control/.dev.vars` with a random local box token. Use `CLOUDAGENTS_PORT=8797 nix run` if 8787 is taken.

Agents need a model key: add one on the Connections page, or export `ANTHROPIC_API_KEY` before `nix run` (the box's broker uses it as a fallback; the sandbox only ever sees a per-run token).

Checks: `nix develop -c bun run typecheck`.

## Deploys

- **Web and control plane:** Workers Builds deploys `main` (build `bun run build:app`, then `wrangler deploy` in `packages/control`). To deploy by hand: `bunx cf builds create d87f7f0a-5dee-45c5-bb88-e5829c3a7792 --branch main`.
- **Production box:** runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

Pull requests get an isolated Preview at `https://<branch>-kestrel.jarenmchugh.workers.dev` (branch name with `/` replaced by `-`). It has its own empty Hub, no production secrets and no box, so it is for UI review.

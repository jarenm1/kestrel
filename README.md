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

Several people can run `nix run` on one machine, each from their own clone under their own Linux user. Ports are offset by `(uid - 1000) * 10` (override with `KESTREL_DEV_OFFSET`): uid 1001 gets app 5183, Worker 8798, box 8807. `nix run` prints the ports. From your laptop, forward the app port and open it locally:

```sh
ssh -L 5183:localhost:5183 <you>@<dev-machine>
# then open http://localhost:5183/auth/dev-login
```

Agents need a model key: add one on the Connections page, or export `ANTHROPIC_API_KEY` before `nix run` (the box's broker uses it as a fallback; the sandbox only ever sees a per-run token).

Checks: `nix develop -c bun run typecheck`. Marketing site: `bun run dev:site` (Astro on http://localhost:4321).

## Deploys

- **App and control plane:** Workers Builds deploys `main` (build `bun run build:app`, then `wrangler deploy` in `packages/control`). To deploy by hand: `bunx cf builds create d87f7f0a-5dee-45c5-bb88-e5829c3a7792 --branch main`.
- **Marketing site:** Workers Builds deploys `main` (build `bun run build:site`, then `wrangler deploy` in `packages/site`). Links to the app use `PUBLIC_APP_URL` (default `https://app.kestrel-agent.com`).
- **GitHub sign-in** needs a GitHub OAuth app whose callback URL is `https://app.kestrel-agent.com/auth/github/callback`, with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set as secrets on Worker `kestrel`.
- **Production box:** runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

Pull requests get isolated Previews at `https://<branch>-kestrel.jarenmchugh.workers.dev` (app) and `https://<branch>-kestrel-site.jarenmchugh.workers.dev` (site), branch name with `/` replaced by `-`. The app Preview has its own empty Hub, no production secrets and no box, so it is for UI review.

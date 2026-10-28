# Kestrel architecture and ownership

```mermaid
flowchart TB
  subgraph Browser["Browser"]
    SITE["Marketing site<br/>kestrel-agent.com<br/>packages/site (Astro)<br/>👤 Person 4"]
    APP["App SPA<br/>app.kestrel-agent.com<br/>packages/app (React, TanStack Query)<br/>👤 caayd"]
    VIEW["Desktop viewer + input<br/>DesktopViewer.tsx, desktop/*<br/>👤 Jaren (streaming)"]
  end

  subgraph CF["Cloudflare"]
    SITEW["Worker kestrel-site<br/>static assets"]
    subgraph CTRL["Worker kestrel: packages/control"]
      AUTH["GitHub OAuth, sessions, allow-list<br/>auth.ts, providers.ts<br/>👤 Person 4"]
      API["Control API<br/>/api/me, /connections, /github/repos, /box, /api/automations<br/>api.ts, automations.ts<br/>👤 Person 4"]
      HUB["Hub Durable Object<br/>users, sessions, secrets, relay<br/>hub.ts<br/>👤 Person 4 + Jaren"]
    end
  end

  GH["GitHub<br/>OAuth App kestrel-agent-app"]

  subgraph PC["Jaren's PC: the box, packages/server"]
    RELAY["Relay client<br/>dials out over WSS<br/>relay/*<br/>👤 Jaren"]
    REST["Box REST + WebSockets<br/>repos, tasks, runs, diff, events<br/>http/*, core/service.ts<br/>👤 Jaren"]
    HARN["Harness<br/>runs claude / other CLI agents<br/>core/harness.ts, config.ts<br/>👤 Person 3"]
    MCP["MCP server /mcp/:taskId<br/>desktop_*, workspace_exec, task_report<br/>mcp/handler.ts<br/>👤 Person 3"]
    BROKER["Credential broker<br/>per-run token to real model key<br/>broker/*<br/>👤 Jaren"]
    SB["bwrap sandbox in a systemd scope<br/>per-task memory/CPU/pids limits<br/>agent, exec, desktop apps<br/>sandbox/*<br/>👤 Jaren"]
    DESK["Desktop manager<br/>Xvfb + xdamage-capture → ffmpeg (damage-driven VFR; NVENC next), WebRTC next<br/>desktop/*<br/>👤 Jaren"]
    STATE[("state.json, worktrees<br/>core/state.ts")]
  end

  LLM["Anthropic / OpenAI APIs"]

  SITE -->|Open app| APP
  SITEW --> SITE
  APP -->|HTTPS /api, WSS events| API
  APP -->|sign in| AUTH
  AUTH <-->|OAuth code to token| GH
  API -->|list repos| GH
  API --> HUB
  HUB <-->|relay frames over WSS| RELAY
  VIEW <-->|desktop stream WS| HUB
  VIEW -.->|planned: WebRTC direct| DESK
  RELAY --> REST
  REST --> HARN
  REST --> STATE
  HARN -->|spawn| SB
  SB -->|tool calls| MCP
  SB -->|model calls with run token| BROKER
  BROKER --> LLM
  MCP --> DESK
  MCP --> REST
  DESK --> SB

  PROTO["packages/protocol<br/>shared schemas: relay frames, REST bodies, events<br/>👤 everyone reviews"]
  PROTO -.- APP
  PROTO -.- CTRL
  PROTO -.- PC
```

## How it fits together

- The browser only talks to Cloudflare. `kestrel-agent.com` is the static marketing site; `app.kestrel-agent.com` is the app, served by the same Worker as the API.
- The Hub Durable Object relays app requests to the box over the WebSocket the box dials out to, so nothing on the box is exposed to the internet.
- The control plane signs users in; the box decides what they can see. Each project is owned by the user who added it, and the box serves a project and its tasks, runs and desktops only to that user (identity comes from the relay; the box's own port has no user and gets no project data).
- Automations are user-defined triggers that start a task on the owner's box: a cron schedule in an IANA time zone, or a GitHub `pull_request` event (opened, reopened, ready for review, synchronize, review requested). The Hub stores them, arms one alarm for the next schedule fire, and receives GitHub deliveries at `/webhooks/github` (verified with a per-repo HMAC secret; deduped by delivery id). Each repo has one webhook shared by its automations, created on GitHub with the owner's token when the first enabled GitHub automation is saved; the Hub change is saved first, and the webhook is removed when the last enabled GitHub automation on the repo is deleted, disabled, or switched to a schedule. Removal is best-effort and needs the owner's token; without one the webhook stays and is reused later. Firing starts a task on the box with `fetch`; a PR run also passes `pullRequest` and the PR's base branch, so the task forks from the PR head and its diff shows only the agent's edits. Then the automation's prompt is sent.
- The agent runs inside a bubblewrap sandbox, in a transient systemd scope whose task slice caps memory, CPU and process count, and in the task's own network namespace (pasta): internet yes, host loopback no, except the box port for MCP and the broker. Everything the agent can start (runs, `workspace_exec`, the desktop terminal, `desktop_launch` apps) goes through the same path and shares that namespace. It gets tools through MCP and makes model calls through the broker, so it never holds the real model keys. Each run has one token (`CLOUDAGENTS_MCP_TOKEN`): MCP requires it as a bearer header, the broker takes it in its URL, and both refuse it once the run ends; MCP sessions close with the run.
- GitHub tools (`git_push`, `github_pr_create`, `github_pr_status`, `github_pr_review`) run on the box host, not in the sandbox. The host pushes the task branch to the repo's clone URL with the owner's GitHub token passed only through git's per-process config, and the PR calls use the same token from the host side. Task creation with `fetch` or `pullRequest` fetches the base branch or the pull request head the same way. The token never enters the sandbox environment, tool arguments, tool output, or logs; pushes never force, and base-branch fetches never overwrite local commits (the pull request ref `kestrel/pr-<n>` is force-updated to match GitHub).
- Dotted WebRTC line: planned direct video path from the box to the browser, replacing today's stream relayed through the Hub.

## Owners

| Owner | Area | Starter items |
|---|---|---|
| Jaren | Box runtime, relay, sandbox, broker, desktop/GPU streaming (NVENC, WebRTC) | Encoder switch, WebRTC sender, configurable dev ports |
| caayd | `packages/app` (UI/UX) | Install-on-GitHub link, page titles, reconnect states |
| Person 3 | Harness and MCP | `desktop_scroll`, `desktop_double_click`, fake-agent coverage, `docs/harness.md` |
| Person 4 | OAuth / control plane and `packages/site` | Friendlier "not allowed" page, repo pagination past 100, reconnect on 401, OG image, `/docs` page |

Changes to `packages/protocol` need a review from everyone, since every package depends on it.

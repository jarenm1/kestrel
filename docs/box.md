# The box: harnesses, sandbox and limits

How the agent box (`packages/server`) runs agents. For the big picture see [architecture.md](architecture.md).

## Models and harnesses

Each message runs on the model picked in the composer. The picker lists, per connected provider (an Anthropic or OpenAI key, or a Claude or ChatGPT subscription), the models chosen for it under Models in Settings › Connections; the list is kept per browser. Anthropic models run through Claude Code (`claude -p --model … --effort …`), OpenAI models through Codex app-server (`codex app-server`, driven over JSON-RPC on stdio by `core/codex-app-server.ts`: the box opens or resumes the thread with the model and starts the turn with the effort); `CLOUDAGENTS_ANTHROPIC_COMMAND` / `CLOUDAGENTS_OPENAI_COMMAND` override either command (the OpenAI one must start app-server on stdio). A Codex run's process lives as long as its turn: a message sent while it runs joins the turn at once (`turn/steer`) instead of waiting in the run's `task_inbox`, Stop interrupts the turn (`turn/interrupt`) so its session ends cleanly, and its text, reasoning and command output stream into the chat as Codex writes them. Without a ChatGPT login, the box signs app-server in with the run's broker token (`account/login/start`), which app-server keeps in the task's `CODEX_HOME`. Claude Code runs with `--include-partial-messages`, so its text and thinking stream in the same way; its tool results arrive when each tool finishes. A Claude run takes its prompt on stdin (`--input-format stream-json`, `core/claude-stream.ts`): a message sent while it runs is written to the same session and Claude Code takes it at its next step (after the running tool, or as the next turn of the run while it is only writing text), and Stop sends an `interrupt` control request so the turn ends cleanly in its session. The box closes stdin after the run's first result; Claude Code still answers messages it already has, then exits. Streamed items are published at most every 100 ms each, so a token stream is not one relay message per token. The thinking picker offers only the levels the chosen model supports. A thread resumes its agent session while the provider stays the same; after a switch to the other provider the new run starts a fresh session whose prompt carries the conversation so far (the newest ~60k characters). A message sent with no model (nothing connected) runs on Claude Code's default.

A Claude result with `queued_turn_count > 0` is not the run's final outcome: the queued turns must finish too. Those turns have no process-exit deadline after stdin closes; Codex's three-second exit grace applies only after its turn is done. If Claude exits before a queued turn produces its result, the run fails rather than reporting the earlier turn's success.

Codex records a new thread as resumable only after its first turn starts; an existing thread is recorded at resume. Stopping `/review` interrupts the active reviewer turn, while the outer review turn still determines when the run finishes. Failed turns always produce an error item, including when app-server omits the error payload; a preceding error notification is deduplicated only for its own turn.

Agents need a model key: add one in Settings › Connections. The sandbox only ever sees a per-run token, and the box never reads model keys from its own environment. Users can instead run agents on their own Claude or ChatGPT subscription: sign in under Settings › Connections (the box runs the unmodified `claude auth login` / `codex login --device-auth` in that user's directory). Each user's CLI state lives only on the box under `<CLOUDAGENTS_DATA_DIR>/users/<login>/{claude,codex}`, and the box's CLI runs use their own login; the sandbox sees just the directories of the providers that user has signed in to. Those runs use the login in place of the broker's API key for that provider.

### Harness commands

In an existing thread, type `/` at the start of the composer to discover that thread's harness commands. Claude Code supplies slash commands through its stream-JSON initialization API; Codex lists `/review [instructions]`, `/compact` and `/init`, which the box runs over app-server (`review/start`, `thread/compact/start`, and Codex's own AGENTS.md prompt), then the enabled skills from app-server's `skills/list` as `$skill-name`; `$` lists the skills alone. Codex's other slash commands drive its terminal UI, or have their own place in Kestrel (model picker, Diff tab, new thread). `/review` without instructions reviews the uncommitted changes of every checkout, since the workspace itself is not a repository. Use ↑/↓ to navigate, Enter or Tab to insert without sending, Escape to dismiss; existing arguments are preserved. `/usage` is Kestrel's own: it lists first, also on a new thread, and a message starting with it opens the usage panel instead of reaching the agent, overriding any `/usage` of the harness; text after it stays in the draft. The panel shows the subscription limits each signed-in CLI reports for the user (Claude Code's `get_usage` control request, Codex's `account/rateLimits/read`); the box reads them through the CLI and never handles its tokens. When Codex reports banked resets, the provider shows "N banked resets"; clicking it lists each with its expiry, and "Use reset" spends that one through app-server's `account/rateLimitResetCredit/consume` (`POST /api/cli-auth/codex-cli/banked-resets/use`). Claude Code's CLI exposes no reset interface, so Claude shows none.

Discovery uses `GET /api/tasks/:id/commands?model=<model-id>`, checks thread ownership, and runs the CLI in that thread's workspace with the signed-in user's own CLI home. The discovery sandbox has no network, so repo-controlled config cannot reach the box's loopback services; Claude Code runs with `disableAllHooks` so the workspace's `.claude/settings.json` hooks do not execute. At most four discovery runs execute box-wide; further requests queue, and a full queue answers "command discovery is busy". While a turn is running, its provider takes precedence over the next-turn model picker. Results are briefly cached per user, provider and workspace; discovery starts no model turn and exposes no credential or skill-file paths. The new-thread composer does not query a harness.

### GitHub references

In the web composer, type `#` followed by a positive issue/PR number at the start of a word, for example `Review #156`.
The same autocomplete menu as slash commands offers **PR #156** and **Issue #156**. Use ↑/↓ and Enter or Tab, or click
an option; Escape dismisses it. Selection inserts an inline bold, underlined label with a PR or issue icon. References
survive draft restoration and remain clickable links in sent messages.

A new thread uses its selected repository. An existing thread uses its sole GitHub checkout; with no checkout or
several, choose the repository in the reference menu. Each inserted reference keeps its repository even if a later
reference uses another. Drafts and messages store ordinary Markdown links such as
`[PR #156](https://github.com/jarenm1/kestrel/pull/156)`, so the agent receives the explicit repository, number and kind.
Choosing an option does not claim that the item exists.

The agent can read a reference with the read-only `github_reference_read` MCP tool:
`{ "repo": "jarenm1/kestrel", "number": 156, "kind": "pr" }` (`kind` is `pr` or `issue`).
No checkout is required. The box uses the thread owner's connected GitHub account on the host; its token never reaches
the sandbox. The result includes the current title, body, author, state, URL and conversation. PRs also include branches,
changed files, reviews, review comments and check status when available. Lists are bounded to GitHub's first page of
100 items and tool output is size-limited. Missing or inaccessible numbers return an error; an issue/PR kind mismatch
returns an explicit error instead of silently treating the number as the other kind.

### Automation tools

Agents manage their owner's automations with `automation_list`, `automation_create`, `automation_update` and `automation_delete`. Creation and trigger updates accept either a schedule object (`_tag: "schedule"`, five-field `cron`, IANA `timezone`) or a GitHub object (`_tag: "github"`, non-empty `events`, optional reviewer/branch/draft filters).

The MCP wire schema must expose these alternatives as `anyOf` and the GitHub event list as an array with one object-valued `items` schema, not a tuple. Older Codex CLIs lower `oneOf`-only triggers to strings and cannot deserialize tuple-valued `items`; either loses the usable create/update tools even though direct MCP calls and the control API work.

## Threads and repositories

Threads are private to the user who started them: the box answers every thread, run, diff and desktop route (REST and WebSocket) only for the thread's owner and returns `404` to anyone else. A thread starts with no repository; the agent checks repositories out into the thread's workspace with `repo_checkout`, and the box clones with the owner's own GitHub token, so GitHub decides which repositories someone's agent can read. The broker pays for a run with the keys of the user who started it. At first start after the upgrade, the box turns each old project thread into a thread with one checkout of its branch (uncommitted files included); the old `repos/` and `worktrees/` directories stay on disk (logged).

## Agent sandbox

Under the `strict` and `basic` levels, everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits (see [Resource limits](#resource-limits)) apply to all of the task's processes together. With `CLOUDAGENTS_PROVISIONING=per-thread` they are hard caps with swap off, so the kernel OOM-kills inside the task only. `off` runs agents plainly (below).

`CLOUDAGENTS_SANDBOX` picks the level:

- `strict` (the default when `CLOUDAGENTS_SANDBOX_PATH` is set, as the flake does): the sandbox exposes only `/nix/store` and a toolchain directory from it (`CLOUDAGENTS_SANDBOX_PATH`, `CLOUDAGENTS_SANDBOX_SSL`, set by the flake), and runs in the task's own network namespace (see below).
- `basic` (the default without `CLOUDAGENTS_SANDBOX_PATH`): bubblewrap over the host's own filesystem and network. The host's system directories (`/usr`, `/bin`, `/etc`, `/nix`, ...) are read-only; the thread workspace, the task home (`/home/agent`) and a private `/tmp` are writable; the real `$HOME` and the rest of `/home` are absent. Processes share the host network and IPC, so an agent can reach the box's own loopback services (broker, MCP). `basic` needs `bwrap` (bubblewrap) and, with systemd on, `systemd-run`, on the box's `PATH`; agent commands get the host's `PATH`, so tools an agent uses must be on it (the run's `gh`, a script that calls the box, needs the host's `bash` and `curl`). Agent CLIs installed under `$HOME` (Claude Code's native installer, an npm prefix, nvm) are the exception: at startup the box finds `claude`, `codex` and `node` on its `PATH` and, for those in its home, binds read-only just the PATH entry, the file it resolves to and its npm package directory. They are looked up at every launch, so installing or updating a CLI there (Claude Code updates itself) needs no restart. Nothing else of `$HOME` is visible. The CLIs' own sign-in, status and command discovery run in the same sandbox level, so `doctor` checks that each CLI starts inside it.
- `off`: agent commands run as plain `sh -c`, with no bubblewrap. `bun run dev` starts the box this way when no Nix toolchain is configured. Fine for local work, never for a shared or production box.

`CLOUDAGENTS_SANDBOX=0` (the old spelling of `off`) is rejected at startup.

### Network and IPC

Each task has its own network namespace, made by `pasta` (passt) when the task first launches something and shared by all of that task's sandboxes, so a browser on the task desktop reaches the agent's dev server on `localhost`. Outbound internet works through pasta's user-space NAT. The host's `127.0.0.1` is out of reach except the box port, which is forwarded in for the broker and MCP. Other tasks' servers and X servers that listen on abstract sockets (such as a desktop session's `:0`) are out of reach too, and the task's own servers are not published on the host. The LAN and the host's non-loopback addresses are still reachable. pasta and its holder process live in the task slice and go away with the task.

The holder of that namespace also owns the task's own SysV IPC namespace (`unshare --ipc`). The task's sandboxes, its X server and the box's capture and screenshot processes for it all join it, so GTK and Qt apps on the desktop can use X shared memory (MIT-SHM), and no task can attach another task's shared memory. Starting a desktop therefore starts the task's pasta and holder if nothing else has, and the desktop fails to start if pasta does. Processes keep the namespaces they started in: if the holder dies and is replaced while a desktop runs, apps launched afterwards no longer share memory with that desktop's X server until the desktop is restarted.

### Desktop

The task desktop is not started with the run. The agent starts it with `desktop_open` when it needs one (or you start it from the Desktop tab), and the desktop tools fail until it is running. A run started without a desktop has no `DISPLAY`, so the agent starts apps with `desktop_launch`, whose sandbox has the display; its `PATH` (the flake's `sandboxEnv`) has `xterm` and `firefox` as GUI apps. An app that exits within half a second is reported with its exit status and output, and a non-zero exit is a tool error.

Each desktop's X server is a rootful Xwayland in a headless weston. On a host with a GPU, weston and Xwayland render on it, and every sandbox that can draw on the desktop gets the GPU too: the DRM render nodes (not the card nodes, which can modeset), NVIDIA's `/dev/nvidia*`, `/sys/dev` and `/sys/devices` read-only (Mesa finds a node's driver there), and the host's drivers at `/run/opengl-driver`. Apps get hardware GL and Vulkan only where those drivers are, i.e. on NixOS; elsewhere, and on hosts without a GPU, the flake's toolkit wrappers fall back to Mesa's software drivers (llvmpipe for GL, lavapipe for Vulkan). Desktops share the GPU: one task's app can use all of its memory.

GPU access is not a tenant isolation boundary: desktop apps reach the host GPU driver and share its memory and scheduling. Keep the existing task CPU/RAM limits, but do not treat them as a VRAM quota.

The box styles the desktop to match the app: `hsetroot` paints `desktop/wallpaper.png` (the logo on black) on the root window, openbox runs with the theme, fonts and bindings from `desktop/theme.ts`, and the flake's `xterm` wrapper uses the app's colors. Openbox gets an explicit set of bindings and an empty menu file, so nothing on the desktop runs a program outside the sandbox: its stock root menu launches programs as the box user. Right-clicking the desktop lists the open windows instead, which is also the way back to an iconified window.

#### Desktop stream bundling (`CLOUDAGENTS_DESKTOP_BUNDLE_MS`)

On the legacy relay, the desktop stream goes through the Hub Durable Object, and every message the box sends it is a billed request (20 messages count as one). The encoder writes one fragment per frame, so continuous motion (scrolling, video) at 30 fps is about 30 messages a second per viewer; a still desktop sends nothing. `CLOUDAGENTS_DESKTOP_BUNDLE_MS` (default `0`, off; whole ms up to 1000) sends at most one message per window per viewer:

- The first frame after a quiet window goes out at once, so a keystroke or a click on an otherwise still desktop has no added latency.
- Frames that come while one is held are concatenated into one message, sent when the window is up. A keyframe starts a new message; init segments are never bundled; a message is cut at 1 MiB.
- Pending frames go out before any status message, so the viewer sees them in order. Acks and flow control count messages, not frames.

What it costs, during continuous motion only: added latency per frame, and smoothness, because the browser paints only the newest frame of a message and so shows fewer frames. Simulated with frames at a steady rate:

| Frame rate | Window | Messages/s (was) | Added latency, average / worst |
|---|---|---|---|
| 30 fps | 33 ms | 30 (30) | 0 / 0: saves nothing |
| 30 fps | 50 ms | 20 (30) | 33 / 50 ms |
| 60 fps | 33 ms | 30 (60) | 17 / 33 ms |
| 60 fps | 50 ms | 20 (60) | 33 / 50 ms |

Try `33` at 60 fps or `50` on the real box and watch typing, scrolling and video before keeping it.

### Toolkits

Heavy desktop apps are opt-in per task, never in `sandboxEnv`. The agent installs one with the `toolkit_install` MCP tool: `blender` (Blender) or `roblox-studio` (Roblox Studio through Vinegar, plus Rojo and Wally). The box builds the flake's `toolkit-<name>` package with `nix build` on the host (the first install on a box downloads it, which can take minutes; later ones reuse `/nix/store`), keeps the out-links under the task home in `.kestrel/toolkits/<name>/` as their GC roots, and links its executables into `.kestrel/bin`, which is last on every sandbox `PATH`, the agent's already-running shell included. Toolkits need a box started through Nix (`CLOUDAGENTS_TOOLKITS_FLAKE`, set by the flake) on x86_64 Linux; without it the agent is not offered `toolkit_install`.

Roblox Studio through Vinegar is community-supported and can break when Studio changes. The toolkit's `vinegar` writes the sandbox's defaults on first run (only where the task has no Vinegar config yet): the `Vulkan` renderer, since DXVK crashes Studio on lavapipe, and Web Pages off, since Studio's embedded WebView2 sign-in never loads under Wine here. Studio then signs in through the browser: its "Login via Browser" goes through the toolkit's `xdg-open` to Firefox on the task desktop, where the user signs in to roblox.com (Quick Sign-in with a code approved on a device already signed in, or an emailed one-time code, avoids typing a password into the remote desktop), and Firefox hands the returned `roblox-studio-auth:` link to Vinegar, which passes it to Studio. Studio can outgrow the default 4 GB task memory limit.

### Software on other boxes

Toolkits are Kestrel's curated installs and exist only on boxes started from the flake. Other boxes have no install tool; agents use what the host has. Under `basic` the sandbox sees the host's `/usr`, `/opt` and so on read-only, so the operator installs apps on the host (`apt`, `dnf`, ...) and agents can run them. Agents can also install into their own home with user-space tools (`npm`, `uv`, `cargo install`, binaries in `~/.local/bin`). They cannot `sudo`: bubblewrap sets `no_new_privs`, which stops setuid binaries, and `/usr` is read-only anyway. Only with sandbox `off` and passwordless sudo for the box user can an agent run `sudo apt-get install` itself, which hands it the host.

## Resource limits

Defaults below are the server's, which keep Kestrel's shared box on hard per-thread caps. A user's own box installed with `kestrel-box` runs with the CLI's shipped config instead: `guaranteed`, box memory `80%`, box CPU 80% of the cores, one agent run per core (see [byo-box.md](byo-box.md#install-your-own-box)).

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDAGENTS_SANDBOX` | `strict` with `CLOUDAGENTS_SANDBOX_PATH`, else `basic` | `strict`, `basic` or `off`, see [Agent sandbox](#agent-sandbox) |
| `CLOUDAGENTS_PROVISIONING` | `per-thread` | How each task's slice is provisioned. `guaranteed`: `MemoryLow` and `CPUWeight` (a floor, not a cap) plus `TasksMax`; a task may use spare memory and CPU. `pooled`: `TasksMax` only. `per-thread`: hard `MemoryMax`, `CPUQuota` and `TasksMax` per task, swap off |
| `CLOUDAGENTS_TASK_MEMORY_MIN` | `1G` | `MemoryLow` per task under `guaranteed` |
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | `MemoryMax` per task under `per-thread` |
| `CLOUDAGENTS_TASK_CPU_WEIGHT` | `100` | `CPUWeight` per task under `guaranteed` (1 to 10000) |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | `CPUQuota` per task under `per-thread` (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | `TasksMax` (processes + threads) per task, in every mode |
| `CLOUDAGENTS_BOX_MEMORY_MAX` | `infinity` | `MemoryMax` of the whole box slice: all its tasks together, in every mode |
| `CLOUDAGENTS_BOX_CPU_QUOTA` | all cores | `CPUQuota` of the whole box slice, in every mode |
| `CLOUDAGENTS_MAX_CONCURRENT_RUNS` | `0` (unlimited) | Agent runs that execute at once; the rest wait in a queue, shown in the chat |
| `CLOUDAGENTS_TASK_DISK_MAX` | `50G` | Storage per task (workspace, home, git shadow repos and its attachment files, pending uploads included), enforced by the box; applies with or without systemd |
| `CLOUDAGENTS_DESKTOP_BUNDLE_MS` | `0` (off) | Desktop stream bundling window, see [Desktop stream bundling](#desktop-stream-bundling-cloudagents_desktop_bundle_ms) |
| `CLOUDAGENTS_SYSTEMD` | on | `0` runs without limits (machines without a user systemd manager) |

The box needs the user's systemd manager (`systemd-run --user`) with the memory, cpu and pids controllers delegated (the default on systemd distros). It checks this at startup and refuses to start otherwise; a box that outlives your login session (the production box) needs `loginctl enable-linger <user>`. At startup the box also stops its own slice, killing sandboxes a previous instance left behind; deleting or archiving a task stops its slice and drops its limits. Inspect live sandboxes with `systemd-cgls --user-unit kestrel.slice`.

The storage limit is not a filesystem quota (the box runs unprivileged). The box measures every task's files at startup and every 30 s, and an upload counts as soon as it arrives: one that would take the task past the limit is refused (409). A task over the limit also has new checkouts refused, and a new run's prompt asks the agent to delete files first. If the task is over the limit and still growing (by more than 64 MiB since the last check) while a run or its desktop is going, the box stops them and says so in the chat. A task that is over the limit but shrinking keeps running, so an agent can clean up. The agent's own writes are never blocked mid-way, so a task can briefly pass the limit by whatever it writes in 30 s.

## Managed boxes (fleet)

Kestrel runs its own boxes as a fleet. Each managed box is a row in the control plane's fleet registry (the Hub's `managed_boxes` table) with a public HTTPS URL and its own secret. One managed box serves many users. The control plane assigns each user to one box, and that user's apps call the box directly. Authentication is the same as for a user's own box: the box verifies HS256 box tokens offline with its own secret, `aud` is its box id and `sub` is the user's login.

### Operators

Operators are the GitHub logins in the Worker's `KESTREL_OPERATORS` secret, comma- or whitespace-separated. Set it from `packages/control`:

```sh
bunx wrangler secret put KESTREL_OPERATORS   # e.g. jarenm1,caayd
```

Operators see Settings › Fleet and the `/api/fleet/boxes` routes (`Me.operator` is `true`). Everyone else gets 404 there.

### Assignment and states

A user is assigned lazily, whenever the control plane builds their box list or needs their managed box:

- A user keeps their box while it is `active` or `draining`.
- Otherwise the user is assigned to the active box with the fewest users (ties go to the oldest box).
- With no active box, the user has no managed box, and their apps use the [legacy relay](#legacy-relay).

| State | Meaning |
|---|---|
| `pending` | Registered; gets no users. Configure and check it first. |
| `active` | Gets new users, by the rule above. |
| `draining` | Keeps its users; gets no new ones. |

Nothing moves a box back to `pending`.

### Adding a box

1. In Settings › Fleet, add the box with a name and its public URL (see [Endpoint requirements](#endpoint-requirements)). The secret is shown once. The box starts `pending`.
2. Run the box on its host in managed direct mode, with its id and secret. The same variables can go in `.box.env`, which `nix run .#box` reads:

   ```sh
   CLOUDAGENTS_BOX_ID=<id> CLOUDAGENTS_BOX_SECRET=<secret> CLOUDAGENTS_BOX_MANAGED=1 \
   CLOUDAGENTS_CONTROL_URL=<control plane origin> nix run .#box
   ```

   The box listens on `CLOUDAGENTS_HOST:CLOUDAGENTS_PORT`, by default `127.0.0.1:8787`. If the proxy runs on another host, set `CLOUDAGENTS_HOST` to an address that proxy can reach (see [Deploy modules](#deploy-modules)).
3. Check health: `curl -fsS https://<url>/api/health` must answer. The control plane checks the same URL for the box's status.
4. Activate: set the state to `active`.

### Drain, rotate, delete

- **Drain** (`draining`): no new users. Current users stay assigned and keep using the box. Draining moves nobody, so use it to stop new assignments before maintenance; set `active` again to resume.
- **Rotate the secret** (`POST /api/fleet/boxes/:id/secret`): returns the new secret once. Until the box restarts with it, the box rejects tokens minted under the new secret and cannot fetch credentials. Rotate and restart together, when the box is idle.
- **Delete** (`DELETE`): removes the box row. Its users are unassigned and, on their next box list, move to the active box with the fewest users, or to the relay if there is none. Their threads stay on the deleted box's disk and do not move.

### Endpoint requirements

- HTTPS, and WSS for the event streams, on a DNS-only hostname (not proxied by Cloudflare).
- `/mcp` and `/broker` are never public. They are local sandbox interfaces, so the proxy answers them with 404.
- The box's port (8787 by default) is reachable only from the proxy, never from the internet.

### Deploy modules

The modules are in `deploy/`. Key files must be absolute paths outside `/nix/store`; the modules assert it.

- **Box with a public IP** (a VPS, or the production host on a public address): import `deploy/box-ingress.nix` on the box's own host. Caddy terminates TLS on 80 and 443 and proxies to `127.0.0.1:8787`. No other box port is opened.

  ```nix
  imports = [ /path/to/kestrel/deploy/box-ingress.nix ];
  services.kestrelBoxIngress = { enable = true; hostname = "box1.example.com"; };
  ```

- **Box behind NAT**: import `deploy/box-ingress.nix` on an ingress host with a public IP, and `deploy/box-tunnel.nix` on the box. The box dials out over WireGuard, and the ingress proxies to the box at its tunnel address, `10.203.0.2`.

  ```nix
  # ingress host
  services.kestrelBoxIngress = {
    enable = true;
    hostname = "box1.example.com";
    wireguard = {
      enable = true;
      privateKeyFile = "/var/lib/kestrel/wg-ingress.key";
      peerPublicKey = "<box public key>";
    };
  };

  # box host
  services.kestrelBoxTunnel = {
    enable = true;
    privateKeyFile = "/var/lib/kestrel/wg-box.key";
    ingressPublicKey = "<ingress public key>";
    endpoint = "ingress.example.com:51820";
  };
  ```

  Set `CLOUDAGENTS_HOST=10.203.0.2` on the box. That address exists only while the tunnel is up, so start the box after the tunnel. The box port opens only on the tunnel interface.

### Cutover of the relayed production box

The production box already dials the relay with `CLOUDAGENTS_BOX_TOKEN`. It keeps that token while it also serves direct traffic: the relay and managed direct mode run in one process, so no user loses the box during the switch.

1. Register it: add the box in Settings › Fleet with its public URL. It is `pending` and gets no users.
2. Configure the endpoint: serve that URL to `127.0.0.1:8787` on the production host, with `deploy/box-ingress.nix` or your own proxy that meets the [endpoint requirements](#endpoint-requirements).
3. In `.box.env`, next to `CLOUDAGENTS_CONTROL_URL` and the kept `CLOUDAGENTS_BOX_TOKEN`, add `CLOUDAGENTS_BOX_ID`, `CLOUDAGENTS_BOX_SECRET` and `CLOUDAGENTS_BOX_MANAGED=1`.
4. Restart the box when it is idle. A restart interrupts agent runs, and `box-auto` defers its restarts while the box is busy.
5. Verify through the public URL: `https://<url>/api/health` answers, and `https://<url>/mcp` answers 404.
6. Activate. The box is then the only active box, so every user without a managed box is assigned to it on their next box list. Users keep it while it is `active` or `draining`.

Rollback: Drain does not move users, so they keep the box. To move them back to the relay, delete the box. Its users go to another active box if one exists, otherwise to the relay. The relay works only while the box still runs with `CLOUDAGENTS_BOX_TOKEN`, so keep that token set until the cutover is final.

### Production host

The production host runs the box with `nix run .#box-auto`. It keeps its own clone in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`) and polls GitHub every 60 s (`KESTREL_BOX_POLL`). It follows the git ref in `KESTREL_BOX_REF` (default `main`), checking it out at startup. When the ref moves, box-auto fast-forwards to the new commit, reinstalls deps and restarts the box, but only once the box is idle: no agent runs and no desktops, as reported on the box's activity socket. While the box is busy the update is deferred and rechecked on every poll. An update that has waited `KESTREL_BOX_MAX_DEFER` seconds (default 21600, 6 h; 0 waits indefinitely) runs anyway and interrupts whatever is still running. If the activity socket does not answer, box-auto updates without an idle check.

The box serves the activity socket at `box.sock` in its data dir: `CLOUDAGENTS_DATA_DIR` from `.box.env` (must be an absolute path; box-auto refuses a relative one), otherwise `.data` in the clone. Only counts leave that socket, and it is owner-only.

To ship a change to the box without merging to `main`, push the commit to a release branch and point the box at it: `git push origin <sha>:box-release`, then start box-auto with `KESTREL_BOX_REF=box-release`. Relaunching box-auto restarts the box once, interrupting any run in progress; after that, pushes to the ref follow the rules above.

It reads the box's environment (`CLOUDAGENTS_CONTROL_URL`, and the relay token and/or managed box id and secret above) from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

### Control plane traffic per user

Per user, the control plane (the Worker and its Hub Durable Object) handles only short control requests. None carries thread data:

- the box list (`GET /api/boxes`), which assigns the managed box;
- a box token from `POST /api/boxes/:id/token`, valid for an hour, for the user's own box or managed box;
- credential bootstrap: the box fetches its user's connection secrets from `/box/credentials` when a token's credentials version changes;
- automation dispatch: the control plane calls the box directly with a 5-minute token to start automation runs and fetch CLI sign-in state, and the box's automation tools call `/box/automations` with its own box auth.

### Legacy relay

Until every client and box is cut over, Kestrel's box is also reached through the relay. A box dials `/box/connect` with `CLOUDAGENTS_BOX_TOKEN`, and the control plane forwards each app request over that socket, one Durable Object request per request. Clients use the relay when `BoxList.managedBox` is `null`. Relay deletion is a later change.

Don't run a box against production with the production token from your machine: the control plane keeps one relayed box and a new connection replaces the live one.

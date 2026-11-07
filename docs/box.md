# The box: harnesses, sandbox and limits

How the agent box (`packages/server`) runs agents. For the big picture see [architecture.md](architecture.md).

## Models and harnesses

Each message runs on the catalog route picked in the composer. Compatible API-key models are offered under multiple
harnesses; the provider still selects the credential and quota. Settings › Connections controls visible models per
browser. See [the compatibility matrix](harnesses.md#harness-compatibility). Subscription logins retain their native
harness. OpenCode's free models require a Console account and OpenCode 2.0.7+; their credentials stay on the box.

Claude Code uses stream-JSON on stdin (`core/claude-stream.ts`); Codex uses app-server JSON-RPC on stdio
(`core/codex-app-server.ts`); OpenCode uses ACP (`core/acp.ts`). The native command overrides remain
`CLOUDAGENTS_ANTHROPIC_COMMAND`, `CLOUDAGENTS_OPENAI_COMMAND` and `CLOUDAGENTS_OPENCODE_COMMAND`.
Routed models use canonical commands instead: `CLOUDAGENTS_ANTHROPIC_COMMAND` for `@claude`,
`CLOUDAGENTS_CODEX_COMMAND` for `@codex` (the native OpenAI command is not reused, because a route needs the broker's
Responses provider config) and `CLOUDAGENTS_OPENCODE_COMMAND` for `@opencode`. The OpenCode command must not inline
`OPENCODE_CONFIG_CONTENT=…`: the box sets that per run, and an inline assignment in the command would shadow the
generated provider config, failing routed API models with `model not found`. The box warns at startup when a
configured OpenCode command contains it.
Codex opens or resumes the thread with the selected model and starts the turn with its effort. Without a ChatGPT
login, the box signs app-server in with the run's broker token, stored in the task's `CODEX_HOME`.

Claude streams partial text and thinking, and reports tool results as they finish. New messages are written into
its running session; Stop sends an interrupt control request. After the first result, the box closes stdin, but
Claude still answers messages it already accepted before exiting. Codex messages join the active turn through
`turn/steer`; Stop uses `turn/interrupt`. OpenCode streams text, thinking and tools, but new messages wait in
`task_inbox` because ACP cannot steer an active turn; Stop uses `session/cancel`.

OpenCode runs with sessions unshared and updates disabled. Its native free/Go routes use their own credentials;
other API providers use per-run broker tokens, never real keys. Free models retain OpenCode's usage limits.
Streamed items are published at most every 100 ms each. The thinking picker offers only supported levels.
A message with no model uses Claude Code's default.

The OpenCode account uses the existing **Connect** button; the device authorization then opens through **Open sign-in page**.

Google's models run through Antigravity CLI as an ACP server (`agy acp --gemini-dir … --dangerously-skip-permissions`, same driver as OpenCode; `CLOUDAGENTS_GOOGLE_COMMAND` overrides it). They need the user's Google sign-in (below): `agy` reaches them only through it, so a Google run gets no broker keys. Its thinking level is the session's `thought_level` option. agy offers its commands and limits only inside a session, so the composer lists no Google commands and the usage panel shows none.

OpenCode Go is a separate connection and model group from OpenCode's free models. Paste a Go API key under
Settings › Connections; the box imports it over stdin into OpenCode's credential database under
`<CLOUDAGENTS_DATA_DIR>/users/<login>/opencode-go/opencode`, never into the Hub or command-line arguments.
Its native OpenCode ACP route needs OpenCode 2.1+ (`CLOUDAGENTS_OPENCODE_GO_COMMAND` overrides it).
Go models can also run through Claude Code or Codex using the same host-held key through the broker.
The catalog continues to omit Go's Claude, GPT, Gemini and free/contributor variants.

Native Go runs bind that login directory as `XDG_DATA_HOME`; Go runs in Claude Code or Codex do not mount it.
Free OpenCode runs use a separate `<CLOUDAGENTS_DATA_DIR>/users/<login>/opencode` directory and Console account.
Disconnect deletes only the selected provider's login directory and its sessions. The host reads the active Go key
with `opencode auth export --standalone` for usage and alternate-harness requests; neither key nor export reaches
the app. Go usage comes from `https://opencode.ai/zen/go/v1/usage`. A saved but rejected key cannot run models and
reports an error in usage.

A thread retains native sessions separately for each provider and harness. Returning to a route resumes its newest
usable session and carries only messages from subsequent runs. Without one, the run starts fresh with conversation
history. A failed run that never recorded a session invalidates older sessions of the same route (except restart
interruptions); recovery carries history instead of silently losing it.
A session is also recorded with where its CLI kept it: the thread's home (broker
keys) or the user's own CLI login directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). After the user connects or disconnects
that CLI login, the CLI no longer finds sessions from before, so the next run starts fresh with conversation history
instead of failing to resume. A session recorded without its place (before this was tracked) also starts fresh, once.
Automatic deliveries keep the latest run's provider even if it never named
a session. Both full and delta handoffs cap rendered history at 60,000 characters, including peer labels and
separators. An oversized newest turn is explicitly truncated; the new user message is not.

A Claude result with `queued_turn_count > 0` is not the run's final outcome: the queued turns must finish too. Those turns have no process-exit deadline after stdin closes; Codex's three-second exit grace applies only after its turn is done. If Claude exits before a queued turn produces its result, the run fails rather than reporting the earlier turn's success.

Codex records a new thread as resumable only after its first turn starts; an existing thread is recorded at resume. Stopping `/review` interrupts the active reviewer turn, while the outer review turn still determines when the run finishes. Failed turns always produce an error item, including when app-server omits the error payload; a preceding error notification is deduplicated only for its own turn.

A run waiting for its slot back after lending it to delegated work keeps its transcript in run-item snapshots.
A run that has not started its process yet shows its queue item, including while it prepares to launch. Refetching
the transcript must not replace a working parent's history with only that queue item.

Prompts travel only on the provider's stdin protocol, never in `CLOUDAGENTS_PROMPT` or descendant process environments.
Custom harness commands must consume stdin too. Only structured assistant text is saved as the run's conversation
reply; Claude's completed main-agent message is used when its result omits text. Raw stdout/stderr remain in the run
log and live output, not in history sent to another provider or parent agent. This prevents prompt echoes and
diagnostics from recursively becoming conversation context.

Agents need a model key: add one for Anthropic, OpenAI, OpenRouter, Z.ai, DeepSeek, MiniMax or Kimi in Settings › Connections. The sandbox only ever sees a per-run token, and the box never reads model keys from its own environment. Users can instead run agents on their own Claude or ChatGPT subscription: sign in under Settings › Connections (the box runs the unmodified `claude auth login` / `codex login --device-auth` in that user's directory). A subscription login replaces the broker key for Anthropic or OpenAI only; it never replaces an OpenRouter, Z.ai, DeepSeek, MiniMax or Kimi key. Each user's CLI state lives only on the box under `<CLOUDAGENTS_DATA_DIR>/users/<login>/{claude,codex}`, and the box's CLI runs use their own login; the sandbox sees just the directories of the providers that user has signed in to. Those runs use the login in place of the broker's API key for that provider. Settings › Connections labels Codex with the email from its own stored login; when no email is stored (for example an API-key login or an older token), its account stays blank rather than showing the sign-in method or any key material.

A Google account signs in the same way through Antigravity CLI: the box runs `agy acp --login --gemini-dir <dir>` in the user's directory (`<CLOUDAGENTS_DATA_DIR>/users/<login>/antigravity`), the user opens the Google link it prints and sends back the code the page shows (or that page's URL). agy keeps its token and its sessions in that directory (`AGY_GEMINI_DIR` to runs); it has no status or sign-out command, so the box reads the token file (`antigravity-cli/antigravity-oauth-token`) and signs out by removing the directory. A rejected code ends the sign-in; start it again. agy writes the token to a file where it finds no OS keyring (no D-Bus session, as in the sandbox, or WSL); on a desktop session with a keyring it may keep it there instead, and the box would read it as signed out. Connections shows the Google email from the token's ID token when it has one, and leaves the account blank when it does not.

### Git commit identity

Task processes commit as their thread owner using GitHub's ID-based noreply address by default. Some accounts
created before July 18, 2017 still have a username-only noreply address. GitHub's public profile API does not
expose that choice: check the address shown under **GitHub Settings → Emails**, rather than guessing from the
account's age or ID. See [GitHub's email address reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference).

If that address is `LOGIN@users.noreply.github.com`, have the box operator include that owner's login in the
box process's `CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS` environment variable before starting it:

```sh
export CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS=legacy-owner,another-owner
```

This is a comma-separated, case-insensitive list of **thread owners**, not repository owners. Only those owners
use the legacy address; everyone else keeps `ID+LOGIN@users.noreply.github.com`. No private email is needed.
If an owner switches to GitHub's ID-based format, remove their login from the list. Apply changes by restarting
the box when idle (a restart interrupts running agents); they affect newly launched processes, not existing
processes or commits. On a managed box, ask its operator to make this selection.

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

Under the `strict` and `basic` levels, everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits (see [Resource limits](#resource-limits)) apply to all of the task's processes together. With `CLOUDAGENTS_PROVISIONING=per-thread` they are hard caps: the kernel throttles a task above `CLOUDAGENTS_TASK_MEMORY_HIGH` (default 90% of `CLOUDAGENTS_TASK_MEMORY_MAX`) and OOM-kills inside the task only at `CLOUDAGENTS_TASK_MEMORY_MAX`, with no swap unless `CLOUDAGENTS_TASK_SWAP_MAX` allows some and `CLOUDAGENTS_BOX_SWAP_MAX` allows it for the box. `off` runs agents plainly (below).

Swap is off by default, so a task that outgrows its memory is killed rather than slowed. Where swap is allowed, it should sit on a compressed RAM device (zram, or zswap in front of a disk swap) on the host, which is fast enough that the kernel's reclaim stays cheap. Even then, a task can thrash in swap without being killed; on a host running `systemd-oomd`, set `ManagedOOMMemoryPressure=kill` on the box's slice (`systemctl --user set-property kestrel-box<port>.slice ManagedOOMMemoryPressure=kill`) so the manager kills a task whose memory pressure stays high instead of letting it thrash.

`CLOUDAGENTS_SANDBOX` picks the level:

- `strict` (the default when `CLOUDAGENTS_SANDBOX_PATH` is set, as the flake does): the sandbox exposes only `/nix/store` and a toolchain directory from it (`CLOUDAGENTS_SANDBOX_PATH`, `CLOUDAGENTS_SANDBOX_SSL`, set by the flake), plus `/usr/bin/env` and shell interpreter paths (`/bin/sh`, `/bin/bash`, `/usr/bin/sh`, `/usr/bin/bash`) linked into that toolchain when available. Repository scripts can use those shebangs without exposing the host's `/bin` or `/usr`. It runs in the task's own network namespace (see below).
- `basic` (the default without `CLOUDAGENTS_SANDBOX_PATH`): bubblewrap over the host's own filesystem and network. The host's system directories (`/usr`, `/bin`, `/etc`, `/nix`, ...) are read-only; the thread workspace, the task home (`/home/agent`) and a private `/tmp` are writable; the real `$HOME` and the rest of `/home` are absent. Processes share the host network and IPC, so an agent can reach the box's own loopback services (broker, MCP). `basic` needs `bwrap` (bubblewrap) and, with systemd on, `systemd-run`, on the box's `PATH`; agent commands get the host's `PATH`, so tools an agent uses must be on it (the run's `gh`, a script that calls the box, needs the host's `bash` and `curl`). Agent CLIs installed under `$HOME` (Claude Code's native installer, an npm prefix, nvm, agy's installer) are the exception: at startup the box finds `claude`, `codex`, `opencode`, `agy` and `node` on its `PATH` and, for those in its home, binds read-only just the PATH entry, the file it resolves to and its npm package directory. They are looked up at every launch, so installing or updating a CLI there (Claude Code updates itself) needs no restart. Nothing else of `$HOME` is visible. The CLIs' own sign-in, status and command discovery run in the same sandbox level, so `doctor` checks that each CLI starts inside it.
- `off`: agent commands run as plain `sh -c`, with no bubblewrap. `bun run dev` starts the box this way when no Nix toolchain is configured. Fine for local work, never for a shared or production box.

The box reports in `GET /api/capabilities` (`harnesses`) which providers' configured CLI commands it found at startup, on the PATH agent runs get (the toolchain under `strict`), new enough to run: free OpenCode needs 2.0.7, OpenCode Go needs 2.1, and Antigravity needs 1.5. Install OpenCode with `npm i -g @opencode/cli`; the `opencode-ai` package and opencode.ai/install are OpenCode 1. Both apps read this snapshot and CLI logins from the selected box, combine them with Worker-stored accounts/keys, and isolate the resulting connections cache when switching boxes. A box that has a CLI installed later offers it after a restart; each ACP launch also checks that provider's current configured command and minimum version.

`CLOUDAGENTS_SANDBOX=0` (the old spelling of `off`) is rejected at startup.

### Network and IPC

Each task has its own network namespace, made by `pasta` (passt) when the task first launches something and shared by all of that task's sandboxes, so a browser on the task desktop reaches the agent's dev server on `localhost`. Outbound internet works through pasta's user-space NAT. The host's `127.0.0.1` is out of reach except the sandbox listener, which is forwarded in for the broker, MCP and GitHub. Other tasks' servers and X servers that listen on abstract sockets (such as a desktop session's `:0`) are out of reach too, and the task's own servers are not published on the host. The LAN and the host's non-loopback addresses are still reachable. pasta and its holder process live in the task slice and go away with the task.

The sandbox listener binds only `127.0.0.1` and serves only MCP, the broker and GitHub (`/gh/`). Its port defaults to the public box port plus 10,000, wrapping within 1–65535; set `CLOUDAGENTS_SANDBOX_PORT` to another free port if needed. It must differ from `CLOUDAGENTS_PORT`. Keep this listener local and point tunnels and proxies at the public box port, never the sandbox port. Both interfaces still require a live run token. Basic and off sandbox modes share the host network, so other local processes can reach this listener too.

`bun packages/server/scripts/test-listeners.ts <off|basic|strict>` checks the listener split with a real box process, a local control stub and a fake agent. It exercises authenticated API and event connections, MCP, the broker, workspace execution and token revocation without model keys. Add `--managed` to check the managed credential path. `basic` needs bubblewrap on `PATH`. `strict` needs bubblewrap, pasta, `/dev/net/tun` and the Nix toolchain (`CLOUDAGENTS_SANDBOX_PATH`, which `nix develop` sets). Under `strict` the agent's own loopback must also be unable to reach the box's public port or the control stub, so the script checks that as well.

The holder of that namespace also owns the task's own SysV IPC namespace (`unshare --ipc`). The task's sandboxes, its X server and the box's capture and screenshot processes for it all join it, so GTK and Qt apps on the desktop can use X shared memory (MIT-SHM), and no task can attach another task's shared memory. Starting a desktop therefore starts the task's pasta and holder if nothing else has, and the desktop fails to start if pasta does. Processes keep the namespaces they started in: if the holder dies and is replaced while a desktop runs, apps launched afterwards no longer share memory with that desktop's X server until the desktop is restarted.

### Desktop

The task desktop is not started with the run. The agent starts it with `desktop_open` when it needs one (or you start it from the Desktop tab), and the desktop tools fail until it is running. A run started without a desktop has no `DISPLAY`, so the agent starts apps with `desktop_launch`, whose sandbox has the display; its `PATH` (the flake's `sandboxEnv`) has `xterm` and `firefox` as GUI apps. An app that exits within half a second is reported with its exit status and output, and a non-zero exit is a tool error.

Each desktop's X server is a rootful Xwayland in a headless weston. On a host with a GPU, weston and Xwayland render on it, and every sandbox that can draw on the desktop gets the GPU too: the DRM render nodes (not the card nodes, which can modeset), NVIDIA's `/dev/nvidia*`, `/sys/dev` and `/sys/devices` read-only (Mesa finds a node's driver there), and the host's drivers at `/run/opengl-driver`. Apps get hardware GL and Vulkan only where those drivers are, i.e. on NixOS; elsewhere, and on hosts without a GPU, the flake's toolkit wrappers fall back to Mesa's software drivers (llvmpipe for GL, lavapipe for Vulkan). Desktops share the GPU: one task's app can use all of its memory.

GPU access is not a tenant isolation boundary: desktop apps reach the host GPU driver and share its memory and scheduling. Keep the existing task CPU/RAM limits, but do not treat them as a VRAM quota.

The box styles the desktop to match the app: `hsetroot` paints `desktop/wallpaper.png` (the logo on black) on the root window, openbox runs with the theme, fonts and bindings from `desktop/theme.ts`, and the flake's `xterm` wrapper uses the app's colors. Openbox gets an explicit set of bindings and an empty menu file, so nothing on the desktop runs a program outside the sandbox: its stock root menu launches programs as the box user. Right-clicking the desktop lists the open windows instead, which is also the way back to an iconified window.

#### Desktop dependencies on Linux

Ubuntu 24.04 packages weston 13.0.0, and the desktop needs weston 14 or newer (see the [README](../README.md)). With Nix and flakes enabled (`experimental-features = nix-command flakes` in `/etc/nix/nix.conf` or `~/.config/nix/nix.conf`), from the checkout root build the desktop tools pinned by this checkout's `flake.lock`, including weston 16, Xwayland, ffmpeg, openbox, hsetroot, xterm, xdotool and the `xdamage-capture` helper:

```sh
mkdir -p "$HOME/.local/share/kestrel"
nix build .#desktop-deps --out-link "$HOME/.local/share/kestrel/desktop-deps"
export PATH="$(readlink -f "$HOME/.local/share/kestrel/desktop-deps")/bin:$PATH"
```

Run the box from that environment, or run `kestrel-box install` from it so the user service records the store path on its `PATH`. `install` also compiles its own `xdamage-capture` into `~/.local/share/kestrel/bin`, which that `PATH` searches first, so the bundle's helper is used only if that build fails. The build needs a C compiler (`$CC`, default `cc`) and the X11, Xext, Xdamage and Xfixes headers; without them `install` warns and continues. Keep the output link: it prevents garbage collection of the tools used by the service. Rebuild and reinstall the service to pick up a newer checkout's dependencies. The box and agent sandbox still need their own prerequisites; this bundle supplies desktop commands only. Nix is optional if equivalent host packages and the compiled capture helper are already installed.

From a checkout with Bun dependencies installed, `bun packages/server/scripts/desktop-smoke.ts` exercises a real desktop's stream, screenshot and pointer input using the tools on `PATH`. A successful smoke test proves only that environment; it does not establish WSL, Lima or GPU behavior. WSLg's read-only `/tmp/.X11-unix` remains a separate setup issue.

#### WebRTC desktop

Desktop video, audio and input travel over WebRTC only; there is no WebSocket media fallback, and WebRTC is always on. The desktop WebSocket (`/api/tasks/:id/desktop/stream`) carries the status and signaling.

- **Signaling** is `rtc.*` JSON on the desktop WebSocket, so it is authenticated like the status and only the thread's owner reaches it. The viewer sends `rtc.offer`, `rtc.candidate`, `rtc.close` and `rtc.config.request`; the box sends `rtc.config`, `rtc.answer`, `rtc.candidate` and `rtc.unavailable`. Signaling also works over the legacy relay, where a session costs a handful of Hub requests. A viewer whose attempt fails tells the user and retries after 1 s, doubling to 30 s; a retry on a config over 30 minutes old asks for a new one first, so TURN credentials do not go stale.
- **Media** is H.264 video and Opus audio (48 kHz stereo, 10 ms frames) on recvonly transceivers. A desktop without audio dependencies still streams video; its audio m-line is answered inactive. Silent Opus packets (2 bytes or less) are gated to one per 400 ms, so a quiet desktop sends almost no audio; audible packets always pass. The audio server starts with the desktop, which waits up to 3 s for it so early apps get its socket; the Opus capture runs only while there are viewers (with the encoder's 15 s linger). Audio that dies is restarted up to three times per desktop; apps already running keep their old socket and stay silent.
- **Input** runs over data channels. `input` (ordered, reliable) carries key, button, wheel and text input; `pointer` (unordered, no retransmits) carries mouse moves only. Wheel notches are clamped to ±10 per event, and `text` (at most 1000 characters) is typed with `xdotool type`.
- **Video** comes from one encoder per desktop, shared by every viewer, with a paced RTP sender per viewer (`desktop/rtp.ts`). A keyframe request (PLI or FIR) or a joining viewer gets the current GOP replayed, unless it is over 4 MiB, in which case the viewer waits for the next keyframe. Replays take at most a quarter of the pacing rate. A viewer more than a second behind has its queue dropped and resumes at the next keyframe. Where the browser offers the playout-delay header extension, it is set to zero.
- **Codec** is H.264 with packetization-mode 1, one encoder per desktop. The default is High 4:2:0 (`-profile:v high -bf 0`, level 4.0 in the SPS), answered with `640c` or `6400` (`f400` is also accepted, untested). If any connected viewer offers only Constrained Baseline (`42e0`, `42c0`, `4200`), the encoder switches to Constrained Baseline for all viewers while that viewer is connected, and that viewer is answered with a Baseline payload. Level is ignored in negotiation, as libwebrtc ignores it. A browser that offers none of these gets `rtc.unavailable` with `retryable: false`. Scaling is bicubic (`scale_cuda interp_algo=3`; `flags=area` on the CPU encoder, and for NVENC when the box's ffmpeg has no CUDA filters).
- **Load**: the stream is encoded once whatever the viewer count. Each viewer costs box CPU for encryption and pacing. The box carries 16 viewers; past that, new ones get `rtc.unavailable` and retry later.

The default STUN server, `stun:stun.cloudflare.com:3478`, lets both ends discover their public addresses. Registered boxes also obtain managed TURN credentials automatically when the control plane has a Cloudflare Realtime TURN key configured. Viewers prefer direct WebRTC and can use UDP, TCP or TLS on port 443 through the provider when direct connectivity fails. Media never traverses the Worker or Hub.

To enable managed TURN for the fleet, create a [Cloudflare Realtime TURN key](https://developers.cloudflare.com/realtime/turn/generate-credentials/) and set **both** `KESTREL_TURN_KEY_ID` and `KESTREL_TURN_API_TOKEN` on the control Worker. Keep the API token only in Worker secrets; do not put it on boxes or in client builds. Update/restart boxes onto this version. No per-box TURN settings or app update are needed: managed boxes, registered user boxes and the legacy relay box authenticate `POST /box/turn` using their existing box identity.

The control plane issues one-hour credentials, caches them per box until five minutes before expiry and coalesces concurrent requests. Boxes also cache credentials until that margin and include them in the viewer's `rtc.config`; retries requesting new config refresh them. Credentials are bearer access to paid relay bandwidth, not thread authorization; a viewer can reuse them until expiry. The provider API token never leaves the Worker. Authentication is checked even on cache hits.

Neither provider setting configured returns 204 and retains local ICE; partial configuration or provider failure returns a sanitized error. A box waits at most three seconds, logs a warning on failure and retains direct connectivity; it retries on a later config request. Explicit local TURN (a `turn` secret or `turn:`/`turns:` ICE URL) takes precedence and skips managed credentials entirely. Unregistered standalone boxes must supply their own TURN.

Cloudflare bills relayed traffic; see [current pricing and limits](https://developers.cloudflare.com/realtime/turn/). Provisioning the key and deploying the Worker alone does not update running boxes. This integration supplies viewer-side relays: the relay must still reach a box candidate over UDP. It does not make a box with no reachable UDP candidate work through an HTTPS tunnel alone, and networks that block non-HTTP TLS even on 443 can still fail. What to set:

| Your network | Settings |
|---|---|
| Box and viewers on a LAN, or the box has a public address | Nothing more; open UDP to the box, narrowed with `CLOUDAGENTS_WEBRTC_PORT_RANGE` if you like |
| Tailscale or WireGuard | `CLOUDAGENTS_WEBRTC_HOST_ADDRESSES` = the box's address on it (tunnel interfaces are not found on their own) |
| Box behind ordinary NAT | Nothing more: the default STUN server sees both ends' public addresses. Set `CLOUDAGENTS_WEBRTC_ICE_SERVERS` to a STUN server of your choice, or to `[]` to use none |
| Symmetric NAT or viewer UDP blocked | Enable managed TURN centrally as above, or supply your own relay with TCP/TLS support using `CLOUDAGENTS_WEBRTC_TURN_URLS` and `CLOUDAGENTS_WEBRTC_TURN_SECRET` |

`CLOUDAGENTS_WEBRTC_TURN_SECRET` is coturn's `static-auth-secret` (`use-auth-secret`). It stays on the box: each session gets a credential minted from it (username `<expiry>:<thread id>`, HMAC-SHA1, valid one hour), for the thread's owner only. It is held like `CLOUDAGENTS_BOX_SECRET`, out of the sandbox's environment. A managed box refuses static TURN passwords in `CLOUDAGENTS_WEBRTC_ICE_SERVERS`, which every viewer could read. `CLOUDAGENTS_WEBRTC_ICE_POLICY=relay` makes viewers send only through TURN; the box still offers its own candidates for the relay to reach. The box itself does not probe a viewer's candidates on loopback, link-local or metadata addresses.

Managed boxes also refuse viewer candidates in private IPv4, carrier-grade NAT, and IPv6 unique-local ranges, including addresses advertised by the box. Viewers on those networks need a reachable public candidate or a TURN relay to see the desktop. Self-hosted boxes keep private LAN and tailnet connectivity.

Limits today:

- Tested on Chromium 155 and on Firefox 158 with Mozilla's OpenH264 plugin. Firefox without that plugin offers no usable H.264 and is refused. Safari is untested. Phones and the web embed use the same viewer; WebRTC on a phone is untested.
- The SPS says level 4.0, the level for 1080p30 and 720p60, whatever level the browser offered, since negotiation ignores level. A browser that offers only a lower level may fail to decode large desktops. Hardware-only decoders may refuse a stream; the viewer then shows a decoder stuck asking for keyframes.
- Constrained Baseline is used only while a Baseline-only viewer is connected. It has no B-frames and uses CAVLC, so it costs about 50% more bytes per frame than High at the same quality setting (measured on a synthetic scroll).
- Pacing follows receiver loss reports, but nothing adapts the encoder's bitrate to the path, so a narrow path loses frames rather than quality.
- A box that can only send through its own TURN allocation is untested: with `relay`, the relay must be able to reach the box directly.
- TURN credentials expire after an hour. If the path then fails, the viewer reconnects and its next attempt gets a new one.
- The peer lives with its WebSocket, so a dropped WebSocket interrupts video until it reconnects.

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
| `CLOUDAGENTS_PROVISIONING` | `per-thread` | How each task's slice is provisioned. `guaranteed`: `MemoryLow` and `CPUWeight` (a floor, not a cap) plus `TasksMax`; a task may use spare memory and CPU. `pooled`: `TasksMax` only. `per-thread`: hard `MemoryMax`, `MemoryHigh`, `CPUQuota` and `TasksMax` per task, with swap per `CLOUDAGENTS_TASK_SWAP_MAX` |
| `CLOUDAGENTS_TASK_MEMORY_MIN` | `1G` | `MemoryLow` per task under `guaranteed` |
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | `MemoryMax` per task under `per-thread` |
| `CLOUDAGENTS_TASK_MEMORY_HIGH` | 90% of `CLOUDAGENTS_TASK_MEMORY_MAX` | `MemoryHigh` per task under `per-thread`: above it the kernel throttles and reclaims the task's memory before the OOM kill at `MemoryMax`. `infinity` disables it. Set it at or below `CLOUDAGENTS_TASK_MEMORY_MAX`: above `MemoryMax` it never takes effect, because the OOM kill comes first (the value is accepted without a warning) |
| `CLOUDAGENTS_TASK_SWAP_MAX` | `0` | `MemorySwapMax` per task under `per-thread`: swap the task may use (`0` none, or e.g. `1G`). Only effective when `CLOUDAGENTS_BOX_SWAP_MAX` allows swap: the box slice's `MemorySwapMax` caps all its tasks together, so with the default `0` a task gets no swap whatever this is set to |
| `CLOUDAGENTS_TASK_CPU_WEIGHT` | `100` | `CPUWeight` per task under `guaranteed` (1 to 10000) |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | `CPUQuota` per task under `per-thread` (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | `TasksMax` (processes + threads) per task, in every mode |
| `CLOUDAGENTS_BOX_MEMORY_MAX` | `infinity` | `MemoryMax` of the whole box slice: all its tasks together, in every mode |
| `CLOUDAGENTS_BOX_SWAP_MAX` | `0` | `MemorySwapMax` of the whole box slice: swap all its tasks share, in every mode |
| `CLOUDAGENTS_BOX_CPU_QUOTA` | all cores | `CPUQuota` of the whole box slice, in every mode |
| `CLOUDAGENTS_MAX_CONCURRENT_RUNS` | `0` (unlimited) | Agent runs that execute at once; the rest wait in a queue, shown in the chat |
| `CLOUDAGENTS_TASK_DISK_MAX` | `50G` | Storage per task (workspace, home, git shadow repos and its attachment files, pending uploads included), enforced by the box; applies with or without systemd |
| `CLOUDAGENTS_WEBRTC_ICE_SERVERS` | `[{"urls":["stun:stun.cloudflare.com:3478"]}]` | JSON array of `{"urls":["stun:host:3478"],"username"?,"credential"?}`, given to the box and every viewer; `[]` uses no STUN server |
| `CLOUDAGENTS_WEBRTC_TURN_URLS`, `CLOUDAGENTS_WEBRTC_TURN_SECRET` | none | Comma-separated `turn:`/`turns:` URLs and the secret to mint per-session credentials with; set together |
| `CLOUDAGENTS_WEBRTC_ICE_POLICY` | `all` | `relay` makes viewers send only through TURN |
| `CLOUDAGENTS_WEBRTC_PORT_RANGE` | any | UDP ports for ICE, e.g. `50000-50100` |
| `CLOUDAGENTS_WEBRTC_HOST_ADDRESSES` | none | Comma-separated addresses to offer that the box does not find by itself, such as its tailnet address |
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

### Active-user telemetry

Settings › Fleet separates **assigned users** (placement) from **active users**: unique assigned logins that made
an authenticated request to that box within the last five minutes. Background polling counts; this is not a measure
of human attention or running agents. HTTP requests and requests on an authenticated WebRTC API channel refresh
activity. Validated preview-token requests also count, including preview documents, HTTP subresources and WebSocket
upgrades; invalid tokens or tokens used for another task do not. Opening a desktop, event or preview WebSocket
stream counts, but traffic on an already-open stream does not; merely watching a desktop can therefore age out.
Legacy relay traffic and user-owned boxes are not included.

Managed boxes send a complete snapshot, including an empty snapshot when idle, every 30 seconds to
`POST /box/telemetry/activity`, authenticated with their box id and secret. Collection is in memory and resets on
box restart; reporting never blocks serving requests. The Hub stores only the latest snapshot per box: login,
last-activity time, and receiver-side report time. It filters users against their current box assignment and retains
no prompts, thread data or activity history. Snapshots are capped at 10,000 users, keeping the most recently active.
Box clocks must be synchronized: timestamps more than 30 seconds ahead of the control plane are rejected; smaller
positive skew is clamped to receiver time.

Operators read `GET /api/fleet/activity`; signed-in non-operators get 404. Fleet refreshes it every ten seconds and
shows usernames, last-seen times and the last report time. A box that has never reported shows telemetry unavailable;
a report at least 90 seconds old shows telemetry stale, not a zero/current count. Box health is separate: an online
box can have stale telemetry. Older boxes need the updated box code before activity is available.

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
- `/mcp`, `/broker` and `/gh/` are served only on the separate loopback sandbox listener, not on the public box port. Existing proxies may continue to block these paths as defense in depth.
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

### Capability discovery

`GET /api/capabilities` returns version 1 with `platform` (`linux`, `wsl`, `lima`, or `other`), the configured
`sandbox` (`strict`, `basic`, or `off`), and `desktop`. `lima` is a Lima guest, detected by its cloud-init seed at
`/mnt/lima-cidata`; Lima guests no longer report `linux`. `prerequisites-present` means Linux and the tools a desktop
start needs (weston 14 or newer, Xwayland, xdotool, ffmpeg, and the xdamage-capture helper) were found at box startup.
openbox, hsetroot and xterm are optional and do not change the answer. It does not guarantee a desktop will start;
permissions, graphics and runtime resources still matter. `unavailable` means that check did not pass. The
`platform` and `sandbox` value sets are closed within version 1: a value outside them is a new contract version.
Additive fields within version 1 may be ignored. The response is a startup snapshot; restart the box after installing
desktop tools to refresh it.

Discovery needs a signed-in user, like the other box routes: send the same box token. Without one it answers 401
`{"_tag":"Unauthorized"}`; a 401 says nothing about the box and means the token is missing or was rejected. A 404 means
an older box without this endpoint. Clients treat a 404 as unknown capabilities and keep their existing behavior. They
must also treat an unsupported contract version as unknown, rather than interpreting it as version 1. This endpoint
does not change health or existing API behavior.

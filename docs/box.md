# The box: harnesses, sandbox and limits

How the agent box (`packages/server`) runs agents. For the big picture see [architecture.md](architecture.md).

## Models and harnesses

Each message runs on the model picked in the composer. The picker lists, per connected provider (an Anthropic or OpenAI key, or a Claude or ChatGPT subscription), the models chosen for it under Models in Settings › Connections; the list is kept per browser. Anthropic models run through Claude Code (`claude -p --model … --effort …`), OpenAI models through Codex app-server (`codex app-server`, driven over JSON-RPC on stdio by `core/codex-app-server.ts`: the box opens or resumes the thread with the model and starts the turn with the effort); `CLOUDAGENTS_ANTHROPIC_COMMAND` / `CLOUDAGENTS_OPENAI_COMMAND` override either command (the OpenAI one must start app-server on stdio). A Codex run's process lives as long as its turn: a message sent while it runs joins the turn at once (`turn/steer`) instead of waiting in the run's `task_inbox`, Stop interrupts the turn (`turn/interrupt`) so its session ends cleanly, and its text, reasoning and command output stream into the chat as Codex writes them. Without a ChatGPT login, the box signs app-server in with the run's broker token (`account/login/start`), which app-server keeps in the task's `CODEX_HOME`. Claude Code runs with `--include-partial-messages`, so its text and thinking stream in the same way; its tool results arrive when each tool finishes. Streamed items are published at most every 100 ms each, so a token stream is not one relay message per token. The thinking picker offers only the levels the chosen model supports. A thread resumes its agent session while the provider stays the same; after a switch to the other provider the new run starts a fresh session whose prompt carries the conversation so far (the newest ~60k characters). A message sent with no model (nothing connected) runs on Claude Code's default.

Agents need a model key: add one in Settings › Connections. The sandbox only ever sees a per-run token, and the box never reads model keys from its own environment. Users can instead run agents on their own Claude or ChatGPT subscription: sign in under Settings › Connections (the box runs the unmodified `claude auth login` / `codex login --device-auth` in that user's directory). Each user's CLI state lives only on the box under `<CLOUDAGENTS_DATA_DIR>/users/<login>/{claude,codex}`, and the box's CLI runs use their own login; the sandbox sees just the directories of the providers that user has signed in to. Those runs use the login in place of the broker's API key for that provider.

### Harness commands

In an existing thread, type `/` at the start of the composer to discover that thread's harness commands. Claude Code supplies slash commands through its stream-JSON initialization API; Codex lists `/review [instructions]`, `/compact` and `/init`, which the box runs over app-server (`review/start`, `thread/compact/start`, and Codex's own AGENTS.md prompt), then the enabled skills from app-server's `skills/list` as `$skill-name`; `$` lists the skills alone. Codex's other slash commands drive its terminal UI, or have their own place in Kestrel (model picker, Diff tab, new thread). `/review` without instructions reviews the uncommitted changes of every checkout, since the workspace itself is not a repository. Use ↑/↓ to navigate, Enter or Tab to insert without sending, Escape to dismiss; existing arguments are preserved.

Discovery uses `GET /api/tasks/:id/commands?model=<model-id>`, checks thread ownership, and runs the CLI in that thread's workspace with the signed-in user's own CLI home. The discovery sandbox has no network, so repo-controlled config cannot reach the box's loopback services; Claude Code runs with `disableAllHooks` so the workspace's `.claude/settings.json` hooks do not execute. At most four discovery runs execute box-wide; further requests queue, and a full queue answers "command discovery is busy". While a turn is running, its provider takes precedence over the next-turn model picker. Results are briefly cached per user, provider and workspace; discovery starts no model turn and exposes no credential or skill-file paths. The new-thread composer does not query a harness.

## Threads and repositories

Threads are private to the user who started them: the box answers every thread, run, diff and desktop route (REST and WebSocket) only for the thread's owner and returns `404` to anyone else. A thread starts with no repository; the agent checks repositories out into the thread's workspace with `repo_checkout`, and the box clones with the owner's own GitHub token, so GitHub decides which repositories someone's agent can read. The broker pays for a run with the keys of the user who started it. At first start after the upgrade, the box turns each old project thread into a thread with one checkout of its branch (uncommitted files included); the old `repos/` and `worktrees/` directories stay on disk (logged).

## Agent sandbox

Everything an agent controls runs in bubblewrap inside a transient systemd scope: the agent run, every `workspace_exec`, the desktop terminal and apps started with `desktop_launch`. Each task gets a slice `kestrel-box<port>-t<task>.slice` (under `kestrel.slice`) whose limits cap all of the task's processes together; swap is off for it, so the memory limit is hard and the kernel OOM-kills inside the task only.

The sandbox exposes only `/nix/store` and a toolchain directory from it (`CLOUDAGENTS_SANDBOX_PATH`, `CLOUDAGENTS_SANDBOX_SSL`, set by the flake). Without `CLOUDAGENTS_SANDBOX_PATH`, `bun run dev` starts the box with `CLOUDAGENTS_SANDBOX=0`, which runs agents unsandboxed: fine for local work, never for a shared or production box.

### Network and IPC

Each task has its own network namespace, made by `pasta` (passt) when the task first launches something and shared by all of that task's sandboxes, so a browser on the task desktop reaches the agent's dev server on `localhost`. Outbound internet works through pasta's user-space NAT. The host's `127.0.0.1` is out of reach except the box port, which is forwarded in for the broker and MCP. Other tasks' servers and X servers that listen on abstract sockets (such as a desktop session's `:0`) are out of reach too, and the task's own servers are not published on the host. The LAN and the host's non-loopback addresses are still reachable. pasta and its holder process live in the task slice and go away with the task.

The holder of that namespace also owns the task's own SysV IPC namespace (`unshare --ipc`). The task's sandboxes, its X server and the box's capture and screenshot processes for it all join it, so GTK and Qt apps on the desktop can use X shared memory (MIT-SHM), and no task can attach another task's shared memory. Starting a desktop therefore starts the task's pasta and holder if nothing else has, and the desktop fails to start if pasta does. Processes keep the namespaces they started in: if the holder dies and is replaced while a desktop runs, apps launched afterwards no longer share memory with that desktop's X server until the desktop is restarted.

### Desktop

The task desktop is not started with the run. The agent starts it with `desktop_open` when it needs one (or you start it from the Desktop tab), and the desktop tools fail until it is running. A run started without a desktop has no `DISPLAY`, so the agent starts apps with `desktop_launch`, whose sandbox has the display; its `PATH` (the flake's `sandboxEnv`) has `xterm` and `firefox` as GUI apps. An app that exits within half a second is reported with its exit status and output, and a non-zero exit is a tool error.

Each desktop's X server is a rootful Xwayland in a headless weston. On a host with a GPU, weston and Xwayland render on it, and every sandbox that can draw on the desktop gets the GPU too: the DRM render nodes (not the card nodes, which can modeset), NVIDIA's `/dev/nvidia*`, `/sys/dev` and `/sys/devices` read-only (Mesa finds a node's driver there), and the host's drivers at `/run/opengl-driver`. Apps get hardware GL and Vulkan only where those drivers are, i.e. on NixOS; elsewhere, and on hosts without a GPU, the flake's toolkit wrappers fall back to Mesa's software drivers (llvmpipe for GL, lavapipe for Vulkan). Desktops share the GPU: one task's app can use all of its memory.

GPU access is not a tenant isolation boundary: desktop apps reach the host GPU driver and share its memory and scheduling. Keep the existing task CPU/RAM limits, but do not treat them as a VRAM quota.

The box styles the desktop to match the app: `hsetroot` paints `desktop/wallpaper.png` (the logo on black) on the root window, openbox runs with the theme, fonts and bindings from `desktop/theme.ts`, and the flake's `xterm` wrapper uses the app's colors. Openbox gets an explicit set of bindings and an empty menu file, so nothing on the desktop runs a program outside the sandbox: its stock root menu launches programs as the box user. Right-clicking the desktop lists the open windows instead, which is also the way back to an iconified window.

#### Desktop stream bundling (`CLOUDAGENTS_DESKTOP_BUNDLE_MS`)

The desktop stream goes through the Hub Durable Object, and every message the box sends it is a billed request (20 messages count as one). The encoder writes one fragment per frame, so continuous motion (scrolling, video) at 30 fps is about 30 messages a second per viewer; a still desktop sends nothing. `CLOUDAGENTS_DESKTOP_BUNDLE_MS` (default `0`, off; whole ms up to 1000) sends at most one message per window per viewer:

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

Heavy desktop apps are opt-in per task, never in `sandboxEnv`. The agent installs one with the `toolkit_install` MCP tool: `blender` (Blender) or `roblox-studio` (Roblox Studio through Vinegar, plus Rojo and Wally). The box builds the flake's `toolkit-<name>` package with `nix build` on the host (the first install on a box downloads it, which can take minutes; later ones reuse `/nix/store`), keeps the out-link under the task home at `.kestrel/toolkits/<name>` as its GC root, and links its executables into `.kestrel/bin`, which is last on every sandbox `PATH`, the agent's already-running shell included. Toolkits need a box started through Nix (`CLOUDAGENTS_TOOLKITS_FLAKE`, set by the flake) on x86_64 Linux.

Roblox Studio through Vinegar is community-supported and can break when Studio changes. The toolkit's `vinegar` writes the sandbox's defaults on first run (only where the task has no Vinegar config yet): the `Vulkan` renderer, since DXVK crashes Studio on lavapipe, and Web Pages off, since Studio's embedded WebView2 sign-in never loads under Wine here. Studio then signs in through the browser: its "Login via Browser" goes through the toolkit's `xdg-open` to Firefox on the task desktop, where the user signs in to roblox.com (Quick Sign-in with a code approved on a device already signed in, or an emailed one-time code, avoids typing a password into the remote desktop), and Firefox hands the returned `roblox-studio-auth:` link to Vinegar, which passes it to Studio. Studio can outgrow the default 4 GB task memory limit.

## Resource limits

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDAGENTS_TASK_MEMORY_MAX` | `4G` | systemd `MemoryMax` per task |
| `CLOUDAGENTS_TASK_CPU_QUOTA` | `200%` | systemd `CPUQuota` per task (100% = one core) |
| `CLOUDAGENTS_TASK_TASKS_MAX` | `1024` | systemd `TasksMax` (processes + threads) per task |
| `CLOUDAGENTS_TASK_DISK_MAX` | `50G` | Storage per task (workspace, home, git shadow repos and its attachment files, pending uploads included), enforced by the box; applies with or without systemd |
| `CLOUDAGENTS_DESKTOP_BUNDLE_MS` | `0` (off) | Desktop stream bundling window, see [Desktop stream bundling](#desktop-stream-bundling-cloudagents_desktop_bundle_ms) |
| `CLOUDAGENTS_SYSTEMD` | on | `0` runs without limits (machines without a user systemd manager) |

The box needs the user's systemd manager (`systemd-run --user`) with the memory, cpu and pids controllers delegated (the default on systemd distros). It checks this at startup and refuses to start otherwise; a box that outlives your login session (the production box) needs `loginctl enable-linger <user>`. At startup the box also stops its own slice, killing sandboxes a previous instance left behind; deleting or archiving a task stops its slice and drops its limits. Inspect live sandboxes with `systemd-cgls --user-unit kestrel.slice`.

The storage limit is not a filesystem quota (the box runs unprivileged). The box measures every task's files at startup and every 30 s, and an upload counts as soon as it arrives: one that would take the task past the limit is refused (409). A task over the limit also has new checkouts refused, and a new run's prompt asks the agent to delete files first. If the task is over the limit and still growing (by more than 64 MiB since the last check) while a run or its desktop is going, the box stops them and says so in the chat. A task that is over the limit but shrinking keeps running, so an agent can clean up. The agent's own writes are never blocked mid-way, so a task can briefly pass the limit by whatever it writes in 30 s.

## Production box

The production box runs on the host machine with `nix run .#box-auto`. It keeps its own clone of `main` in `~/.local/share/kestrel-box` (override with `KESTREL_BOX_DIR`), polls GitHub every 60 s (`KESTREL_BOX_POLL`), and on a new commit fast-forwards and restarts the box, which interrupts in-flight agent runs. It reads `CLOUDAGENTS_CONTROL_URL` and `CLOUDAGENTS_BOX_TOKEN` from `.box.env` in that clone (copied from the current directory on first run). `nix run .#box` runs a box once from the current checkout.

Don't run a box against production with the production token from your machine: the control plane keeps one box and a new connection replaces the live one.

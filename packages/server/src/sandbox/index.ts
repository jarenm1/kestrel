import { Effect } from "effect"
import { spawn } from "node:child_process"
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { InternalError } from "@cloudagents/protocol"
import { desktopScaleEnv } from "../desktop/scale"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup, platformEnv, shell } from "../process"
import { ensureTaskNet, joinTaskIpc, joinTaskNet } from "./netns"
import { applyTaskLimits, busEnv, scopeArgs, type LaunchKind, type SystemdSettings } from "./systemd"

export { stopAllTaskNets, stopTaskNet } from "./netns"
export { initBox, removeTask, type LaunchKind, type SystemdSettings } from "./systemd"

/** Where the per-task home is mounted inside the sandbox. */
export const SANDBOX_HOME = "/home/agent"

/** Under the task home: executables of the task's installed toolkits (`toolkits.ts`), last on every launch's PATH. */
export const TOOLKIT_BIN = ".kestrel/bin"

/**
 * How tightly agent processes are isolated (`CLOUDAGENTS_SANDBOX`):
 * - `strict`: bubblewrap over the nix store, in the task's own network and IPC namespaces (pasta).
 * - `basic`: bubblewrap over the host's system directories, sharing the host's network and IPC. The task home and the
 *   workspace are the only writable paths; the real $HOME is absent.
 * - `off`: no sandbox; commands run under `sh -c`.
 */
export type SandboxLevel = "strict" | "basic" | "off"

/** Host paths exposed read-only when present; enough for DNS, TLS and passwd lookups. */
const SYSTEM_RO_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ssl",
]

/**
 * Where nixpkgs' NSS (Firefox) reads its roots: its root module is p11-kit's trust module with these paths built in,
 * not SSL_CERT_FILE. On NixOS the host files are symlinks into /etc/static, which the sandbox cannot follow.
 */
const CA_BUNDLE_PATHS = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-bundle.crt"]

/**
 * Host dirs `basic` binds read-only: the system, its configuration and the nix store. Missing ones are skipped; the
 * rest of the host is absent inside the sandbox.
 */
const BASIC_RO_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/nix",
  "/run/current-system",
  "/run/systemd/resolve",
]

/** The agent CLIs and the runtime npm-installed ones need; `basic` makes these visible when installed in $HOME. */
const HOME_TOOLS = ["claude", "codex", "node"]

/**
 * bwrap args that let `basic` run agent CLIs installed in the box user's home, which the sandbox otherwise hides:
 * Claude Code's native installer (`~/.local/bin/claude` -> `~/.local/share/claude/versions/<v>`), npm prefixes and nvm.
 * For each of HOME_TOOLS found on `pathEnv`: the file it resolves to and the npm package directory around it, bound
 * read-only when under `home`, and the PATH entry itself recreated as the same symlink, so a node script still finds
 * its package.json next to its real path. Nothing else of the home is exposed.
 */
export const homeToolArgs = (home: string, pathEnv: string): string[] => {
  const inHome = (path: string) => path.startsWith(`${home}/`)
  const binds = new Set<string>()
  const links = new Map<string, string>()
  for (const name of HOME_TOOLS) {
    const found = findExecutable(name, pathEnv)
    if (found === null) continue
    let real: string
    try {
      real = realpathSync(found)
    } catch {
      continue
    }
    if (inHome(found) && found !== real) links.set(found, real)
    if (!inHome(real)) continue
    binds.add(real)
    for (let dir = dirname(real); inHome(dir); dir = dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) {
        binds.add(dir)
        break
      }
    }
  }
  const sorted = [...binds].sort()
  const kept = sorted.filter((path) => !sorted.some((other) => other !== path && path.startsWith(`${other}/`)))
  const within = (path: string) => kept.some((bind) => path === bind || path.startsWith(`${bind}/`))
  return [
    // -try: a CLI that updated itself between this lookup and the launch leaves its old path behind.
    ...kept.flatMap((path) => ["--ro-bind-try", path, path]),
    ...[...links].filter(([link]) => !within(link)).flatMap(([link, target]) => ["--symlink", target, link]),
  ]
}

/** A host dir bound read-write at a path inside the sandbox. */
export interface SandboxBind {
  readonly host: string
  readonly sandbox: string
}

export interface BwrapOptions {
  /** `strict`: the nix store and the DNS/TLS files, in the task's namespaces. `basic`: the host's system directories. */
  readonly level: "strict" | "basic"
  /** The thread workspace: the agent's working directory, bound read-write. Absolute. */
  readonly workspacePath: string
  /** The owner's mirror directory, bound read-only: checkouts read their git objects from it. Absolute. */
  readonly mirrorDir: string
  /** Host dir for the persisted per-task home, bound rw at /home/agent. */
  readonly homeDir: string
  /** X display number of the task desktop; its socket is bound when given. */
  readonly display?: number
  /** Exact environment of the sandboxed process. Nothing else from the host is passed. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  /** Extra host paths mounted read-only at the same location (fake agent only). */
  readonly roBinds?: ReadonlyArray<string>
  /** Host dirs bound read-write inside the sandbox (a signed-in user's CLI logins). */
  readonly binds?: ReadonlyArray<SandboxBind>
  /** CA bundle (CLOUDAGENTS_SANDBOX_SSL) bound at the standard bundle paths in place of the host's /etc/ssl. */
  readonly caBundle?: string | null
  /** `basic` only: bwrap args exposing the agent CLIs installed in the box user's home (`homeToolArgs`). */
  readonly homeToolArgs?: ReadonlyArray<string>
}

/**
 * Returns the full argv, starting with the `bwrap` executable name. `strict` binds the nix store and runs in the task's
 * network and IPC namespaces (joined by the launch, see netns.ts); `basic` binds the host's system directories and
 * shares the host's network and IPC.
 */
export const buildBwrapArgv = (opts: BwrapOptions): string[] => {
  const argv: string[] = [
    "bwrap",
    "--die-with-parent",
    "--new-session",
    // Strict's network and IPC namespaces are the task's own, which the launch joins before bwrap (see netns.ts);
    // basic unshares neither. The IPC namespace is shared with the desktop, so X clients can use MIT-SHM.
    "--unshare-user-try",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    // That namespace maps the box user to root; keep the agent on the box user's own ids (agent CLIs refuse root).
    "--uid",
    String(process.getuid?.() ?? 0),
    "--gid",
    String(process.getgid?.() ?? 0),
    "--clearenv",
    ...(opts.level === "strict"
      ? ["--ro-bind", "/nix/store", "/nix/store"]
      : BASIC_RO_PATHS.flatMap((path) => ["--ro-bind-try", path, path])),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // Nothing under /home is visible except the task home and the workspace binds below.
    "--tmpfs",
    "/home",
    "--bind",
    opts.homeDir,
    SANDBOX_HOME,
    "--bind",
    opts.workspacePath,
    opts.workspacePath,
    "--ro-bind",
    opts.mirrorDir,
    opts.mirrorDir,
  ]
  for (const bind of opts.binds ?? []) argv.push("--bind", bind.host, bind.sandbox)
  for (const path of opts.roBinds ?? []) argv.push("--ro-bind", path, path)
  if (opts.level === "basic") argv.push(...(opts.homeToolArgs ?? []))
  // Basic binds all of /etc, which holds these files.
  if (opts.level === "strict") {
    for (const file of SYSTEM_RO_FILES) {
      if (file === "/etc/ssl" && opts.caBundle) continue
      if (existsSync(file)) argv.push("--ro-bind", file, file)
    }
  }
  if (opts.caBundle) for (const path of CA_BUNDLE_PATHS) argv.push("--ro-bind", opts.caBundle, path)
  if (opts.display !== undefined) {
    const socket = x11Socket(opts.display)
    argv.push("--bind", socket, socket)
    argv.push(...gpuArgs())
  }
  for (const [name, value] of Object.entries(opts.env)) argv.push("--setenv", name, value)
  argv.push("--chdir", opts.workspacePath, "--", "sh", "-c", opts.command)
  return argv
}

/**
 * bwrap args (without the executable) that run `command` with only `homeDir` writable: for the agent CLIs' own
 * sign-in/status/logout/discovery on the box. The process dies with the box (--die-with-parent) and sees only what the
 * box's sandbox level shows agent runs: `strict` the nix store and the DNS/TLS files, `basic` the host's system
 * directories and the agent CLIs installed in the box user's home (`homeToolArgs`). `network: "host"` shares the box's
 * network (sign-in needs it). `network: "none"` gives the process an empty network namespace: discovery never needs
 * the network, and the box's loopback services (broker, MCP, other tasks' servers) must stay out of reach. With
 * `workspacePath` it runs there and sees that thread workspace read-only, so project commands and skills are
 * discoverable.
 */
export const cliBwrapArgs = (
  homeDir: string,
  env: Readonly<Record<string, string>>,
  command: ReadonlyArray<string>,
  options: {
    readonly level: "strict" | "basic"
    readonly homeToolArgs: ReadonlyArray<string>
    readonly network: "host" | "none"
    readonly workspacePath?: string
  },
): string[] => {
  const workspacePath = options.workspacePath
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(options.network === "host" ? ["--share-net"] : []),
    "--clearenv",
    ...(options.level === "strict"
      ? ["--ro-bind", "/nix/store", "/nix/store"]
      : BASIC_RO_PATHS.flatMap((path) => ["--ro-bind-try", path, path])),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--bind",
    homeDir,
    homeDir,
  ]
  if (workspacePath !== undefined) argv.push("--ro-bind", workspacePath, workspacePath)
  if (options.level === "strict") {
    for (const file of SYSTEM_RO_FILES) {
      if (existsSync(file)) argv.push("--ro-bind", file, file)
    }
  } else {
    argv.push(...options.homeToolArgs)
  }
  for (const [name, value] of Object.entries(env)) argv.push("--setenv", name, value)
  argv.push("--chdir", workspacePath ?? homeDir, "--", ...command)
  return argv
}

export const x11Socket = (display: number): string => `/tmp/.X11-unix/X${display}`

/**
 * The host GPU, for processes that can draw on the task desktop: DRM render nodes (never the card nodes, which can
 * modeset), NVIDIA's device files, and the host's GL/Vulkan drivers at /run/opengl-driver, where nixpkgs' libglvnd and
 * Vulkan loader look (NixOS; elsewhere sandboxed apps keep Mesa's software drivers). Mesa finds a render node's driver
 * through sysfs, so /sys/dev and /sys/devices are visible read-only. Empty on a host without a GPU.
 */
const gpuArgs = (): string[] => {
  const devices: string[] = []
  try {
    for (const name of readdirSync("/dev/dri")) if (name.startsWith("renderD")) devices.push(`/dev/dri/${name}`)
  } catch {
    // no DRM devices
  }
  for (const name of readdirSync("/dev")) if (name.startsWith("nvidia")) devices.push(`/dev/${name}`)
  if (devices.length === 0) return []
  const argv: string[] = []
  for (const device of devices) argv.push("--dev-bind", device, device)
  for (const dir of ["/sys/dev", "/sys/devices", "/run/opengl-driver", "/run/opengl-driver-32"]) {
    if (existsSync(dir)) argv.push("--ro-bind", dir, dir)
  }
  return argv
}

/** Parses ":101" into 101 when the desktop socket exists on the host. */
export const displayNumber = (display: string | null): number | undefined => {
  const match = display === null ? null : /^:(\d+)$/.exec(display)
  if (!match) return undefined
  const n = Number(match[1])
  return existsSync(x11Socket(n)) ? n : undefined
}

export interface SandboxSettings {
  /** How launches are isolated; `strict` needs `binPath`. */
  readonly level: SandboxLevel
  /** `CLOUDAGENTS_SANDBOX_PATH`; required for `strict`. */
  readonly binPath: string | null
  /** `CLOUDAGENTS_SANDBOX_SSL`: CA bundle path, exposed as SSL_CERT_FILE. */
  readonly sslCertFile: string | null
  /** Per-task systemd resource limits; null only with `CLOUDAGENTS_SYSTEMD=0`. */
  readonly systemd: SystemdSettings | null
  /** Box HTTP port, forwarded into each task's network namespace for the broker and MCP. */
  readonly boxPort: number
}

export interface LaunchRequest {
  readonly settings: SandboxSettings
  /** Task the process belongs to; its systemd slice carries the resource limits. */
  readonly taskId: string
  readonly kind: LaunchKind
  /** The thread workspace: the agent's working directory. */
  readonly workspacePath: string
  /** The owner's mirror directory, bound read-only into the sandbox. */
  readonly mirrorDir: string
  readonly homeDir: string
  /** X display string (e.g. ":101") of the task desktop, or null. */
  readonly display: string | null
  /** Variables beyond the base allowlist (CLOUDAGENTS_*, broker env). Never host env. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  readonly roBinds?: ReadonlyArray<string>
  /** Host dirs bound read-write inside the sandbox (a signed-in user's CLI logins). */
  readonly binds?: ReadonlyArray<SandboxBind>
}

export interface Launch {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** HOME as the process sees it (`/home/agent` when sandboxed). */
  readonly home: string
}

/** HOME as seen by the launched process; use it to build paths the process reads. */
export const agentHome = (settings: SandboxSettings, homeDir: string): string =>
  settings.level === "off" ? homeDir : SANDBOX_HOME

export const sandboxSettingsOf = (config: {
  readonly sandbox: SandboxLevel
  readonly sandboxPath: string | null
  readonly sandboxSslCertFile: string | null
  readonly systemd: SystemdSettings | null
  readonly port: number
}): SandboxSettings => ({
  level: config.sandbox,
  binPath: config.sandboxPath,
  // The CA bundle belongs to the Nix toolchain; `basic` uses the host's own /etc/ssl and `off` the host as is.
  sslCertFile: config.sandbox === "strict" ? config.sandboxSslCertFile : null,
  systemd: config.systemd,
  boxPort: config.port,
})

/**
 * `homeToolArgs` for this box user, for a `basic` launch. Looked up per launch, not at startup: Claude Code's native
 * installer updates itself into a new versions directory.
 */
export const boxHomeToolArgs = (): string[] => homeToolArgs(homedir(), process.env.PATH ?? "")

export const findExecutable = (name: string, pathEnv: string = process.env.PATH ?? ""): string | null => {
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

const requireSystemdRun = (settings: SandboxSettings): Effect.Effect<string | null, InternalError> => {
  if (!settings.systemd) return Effect.succeed(null)
  const systemdRun = findExecutable("systemd-run")
  return systemdRun === null
    ? Effect.fail(new InternalError({ message: "systemd-run not found on PATH (set CLOUDAGENTS_SYSTEMD=0 to run without limits)" }))
    : Effect.succeed(systemdRun)
}

/** Holder pid of the task's namespaces (started on first use) and the nsenter that joins them. Strict only. */
const taskNamespaces = (
  settings: SandboxSettings,
  taskId: string,
  systemdRun: string | null,
): Effect.Effect<{ readonly holder: number; readonly nsenter: string }, InternalError> =>
  Effect.gen(function* () {
    if (settings.binPath === null) {
      return yield* Effect.fail(new InternalError({ message: "CLOUDAGENTS_SANDBOX_PATH is not set" }))
    }
    const pasta = findExecutable("pasta")
    const nsenter = findExecutable("nsenter")
    const unshare = findExecutable("unshare")
    if (pasta === null || nsenter === null || unshare === null) {
      return yield* Effect.fail(
        new InternalError({
          message: "pasta (passt), nsenter and unshare (util-linux) must be on PATH; run inside `nix develop` or `nix run .#box`",
        }),
      )
    }
    const holder = yield* ensureTaskNet({
      taskId,
      boxPort: settings.boxPort,
      pastaPath: pasta,
      sleepPath: join(settings.binPath, "sleep"),
      unsharePath: unshare,
      systemd: settings.systemd && systemdRun ? { settings: settings.systemd, systemdRun } : null,
    })
    return { holder, nsenter }
  })

const PREVIEW_FETCH_SCRIPT = `
const input = JSON.parse(process.env.KESTREL_PREVIEW_REQUEST);
const bodyChunks = [];
for await (const chunk of process.stdin) bodyChunks.push(Buffer.from(chunk));
const body = Buffer.concat(bodyChunks);
const response = await fetch("http://127.0.0.1:" + input.port + input.path, {
  method: input.method,
  headers: input.headers,
  body: input.method === "GET" || input.method === "HEAD" || body.length === 0 ? undefined : body,
  redirect: "manual"
});
const metadata = JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers) }) + "\\n";
process.stdout.write(metadata);
if (response.body) {
  for await (const chunk of response.body) {
    if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
}
`

/** A bounded HTTP request to a task's loopback-only dev server; never accepts a hostname or an arbitrary target URL. */
export const taskPreviewFetch = (
  settings: SandboxSettings,
  taskId: string,
  input: {
    readonly port: number
    readonly method: string
    readonly path: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: Uint8Array
  },
): Effect.Effect<Response, InternalError> =>
  Effect.gen(function* () {
    const serialized = JSON.stringify({
      port: input.port,
      method: input.method,
      path: input.path,
      headers: input.headers,
    })
    const env = { PATH: process.env.PATH ?? "", KESTREL_PREVIEW_REQUEST: serialized }
    let file = process.execPath
    let args = ["-e", PREVIEW_FETCH_SCRIPT]
    if (settings.level === "strict") {
      const systemdRun = yield* requireSystemdRun(settings)
      if (settings.systemd) yield* applyTaskLimits(settings.systemd, taskId)
      const { holder, nsenter } = yield* taskNamespaces(settings, taskId, systemdRun)
      const joined = joinTaskNet(nsenter, holder)
      file = joined[0]!
      args = [...joined.slice(1), process.execPath, ...args]
    }
    const pending = Promise.withResolvers<Response>()
    const spawned = yield* Effect.try({
      try: () => spawn(file, args, { env, stdio: ["pipe", "pipe", "ignore"] }),
      catch: (e) => new InternalError({ message: `preview request failed to start: ${String(e)}` }),
    })
    spawned.stdin?.end(input.body ? Buffer.from(input.body) : undefined)
    const chunks: Buffer[] = []
    let size = 0
    let timedOut = false
    const maxBytes = 20 * 1024 * 1024
    const timeout = setTimeout(() => {
      timedOut = true
      spawned.kill("SIGKILL")
    }, 25_000)
    spawned.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > maxBytes) {
        spawned.kill("SIGKILL")
        return
      }
      chunks.push(chunk)
    })
    spawned.once("error", pending.reject)
    spawned.once("close", (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        pending.reject(
          new Error(
            size > maxBytes ? "preview response exceeded 20 MiB" : timedOut ? "preview request timed out" : `preview request exited ${code}`,
          ),
        )
        return
      }
      const output = Buffer.concat(chunks)
      const end = output.indexOf(10)
      if (end < 0) {
        pending.reject(new Error("preview server returned an invalid response"))
        return
      }
      try {
        const meta = JSON.parse(output.subarray(0, end).toString("utf8")) as {
          status: number
          headers: Record<string, string>
        }
        const body = input.method === "HEAD" || [204, 205, 304].includes(meta.status) ? null : output.subarray(end + 1)
        pending.resolve(new Response(body, { status: meta.status, headers: meta.headers }))
      } catch {
        pending.reject(new Error("preview server returned an invalid response"))
      }
    })
    return yield* Effect.tryPromise({
      try: () => pending.promise,
      catch: (e) => new InternalError({ message: `preview request failed: ${e instanceof Error ? e.message : String(e)}` }),
    })
  })

const PREVIEW_WEBSOCKET_SCRIPT = `
const input = JSON.parse(process.env.KESTREL_PREVIEW_REQUEST);
const socket = new WebSocket("ws://127.0.0.1:" + input.port + input.path, input.protocol ? [input.protocol] : undefined);
socket.addEventListener("open", () => process.stdout.write(JSON.stringify({ type: "open" }) + "\\n"));
socket.addEventListener("message", (event) => {
  if (typeof event.data === "string") process.stdout.write(JSON.stringify({ type: "text", data: event.data }) + "\\n");
});
socket.addEventListener("close", () => {
  process.stdout.write(JSON.stringify({ type: "close" }) + "\\n");
  process.exit(0);
});
socket.addEventListener("error", () => {
  process.stdout.write(JSON.stringify({ type: "close" }) + "\\n");
  process.exit(1);
});
let lines = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  lines += chunk;
  let end;
  while ((end = lines.indexOf("\\n")) >= 0) {
    const line = lines.slice(0, end);
    lines = lines.slice(end + 1);
    try {
      const message = JSON.parse(line);
      if (message.type === "text" && socket.readyState === WebSocket.OPEN) socket.send(message.data);
      if (message.type === "close") socket.close();
    } catch {}
  }
});
`

export interface TaskPreviewSocket {
  readonly sendText: (data: string) => void
  readonly onText: (listener: (data: string) => void) => void
  readonly onClose: (listener: () => void) => void
  readonly close: () => void
}

/** Opens a WebSocket only to the task's loopback dev server for HMR. */
export const openTaskPreviewSocket = (
  settings: SandboxSettings,
  taskId: string,
  input: { readonly port: number; readonly path: string; readonly protocol?: string },
): Effect.Effect<TaskPreviewSocket, InternalError> =>
  Effect.gen(function* () {
    let file = process.execPath
    let args = ["-e", PREVIEW_WEBSOCKET_SCRIPT]
    if (settings.level === "strict") {
      const systemdRun = yield* requireSystemdRun(settings)
      if (settings.systemd) yield* applyTaskLimits(settings.systemd, taskId)
      const { holder, nsenter } = yield* taskNamespaces(settings, taskId, systemdRun)
      const joined = joinTaskNet(nsenter, holder)
      file = joined[0]!
      args = [...joined.slice(1), process.execPath, ...args]
    }
    const spawned = yield* Effect.try({
      try: () =>
        spawn(file, args, {
          env: { PATH: process.env.PATH ?? "", KESTREL_PREVIEW_REQUEST: JSON.stringify(input) },
          stdio: ["pipe", "pipe", "ignore"],
        }),
      catch: (e) => new InternalError({ message: `preview WebSocket failed to start: ${String(e)}` }),
    })
    let pendingText = ""
    let textListener: ((data: string) => void) | null = null
    const queuedText: string[] = []
    let closed = false
    let closeListener: (() => void) | null = null
    const close = () => {
      if (closed) return
      closed = true
      closeListener?.()
    }
    const startupTimeout = setTimeout(() => spawned.kill("SIGKILL"), 15_000)
    spawned.stdout.on("data", (chunk: Buffer) => {
      pendingText += chunk.toString("utf8")
      let end: number
      while ((end = pendingText.indexOf("\n")) >= 0) {
        const line = pendingText.slice(0, end)
        pendingText = pendingText.slice(end + 1)
        try {
          const message = JSON.parse(line) as { type?: string; data?: string }
          if (message.type === "open") clearTimeout(startupTimeout)
          if (message.type === "text" && typeof message.data === "string") {
            if (textListener) textListener(message.data)
            else queuedText.push(message.data)
          }
          if (message.type === "close") close()
        } catch {
          spawned.kill("SIGKILL")
        }
      }
    })
    spawned.once("close", close)
    return {
      sendText: (data) => {
        if (!closed) spawned.stdin.write(`${JSON.stringify({ type: "text", data })}\n`)
      },
      onText: (listener) => {
        textListener = listener
        for (const data of queuedText.splice(0)) listener(data)
      },
      onClose: (listener) => {
        closeListener = listener
        if (closed) listener()
      },
      close: () => {
        if (closed) return
        spawned.stdin.write(`${JSON.stringify({ type: "close" })}\n`)
        setTimeout(() => spawned.kill("SIGTERM"), 500)
        close()
      },
    }
  })

/**
 * The task's IPC namespace, for the task desktop's X server and the box's MIT-SHM clients of it (capture,
 * screenshots): a process in it now, and the argv prefix that joins a process's IPC namespace. Starts the task's
 * namespaces if needed. Null unless strict: the other levels share the host's IPC.
 */
export const desktopNamespace = (
  settings: SandboxSettings,
  taskId: string,
): Effect.Effect<{ readonly holder: number; readonly join: (pid: number) => string[] } | null, InternalError> =>
  Effect.gen(function* () {
    if (settings.level !== "strict") return null
    const systemdRun = yield* requireSystemdRun(settings)
    if (settings.systemd) yield* applyTaskLimits(settings.systemd, taskId)
    const { holder, nsenter } = yield* taskNamespaces(settings, taskId, systemdRun)
    return { holder, join: (pid: number) => joinTaskIpc(nsenter, pid) }
  })

/**
 * Turns a launch request into the concrete process to spawn. `strict` joins the task's network and IPC namespaces
 * (`nsenter`, started on first use) and runs in bubblewrap over the nix store; `basic` runs in bubblewrap over the
 * host's system directories, sharing the host's network and IPC; `off` runs `sh -c`. The env inside is exactly the
 * base allowlist plus `req.env` (`off` adds the platform env). With systemd limits on, the process starts through
 * `systemd-run --scope` in the task's slice. systemd-run and nsenter exec in place, so the spawned pid is still the
 * sandbox's and process-group signals reach it.
 */
export const prepareLaunch = (req: LaunchRequest): Effect.Effect<Launch, InternalError> =>
  Effect.gen(function* () {
    const { settings } = req
    if (settings.level === "strict" && settings.binPath === null) {
      return yield* Effect.fail(
        new InternalError({
          message:
            "CLOUDAGENTS_SANDBOX_PATH is not set; start the box with `nix run .#box` or inside `nix develop` (or set CLOUDAGENTS_SANDBOX=off for local debugging)",
        }),
      )
    }
    const bwrap = settings.level === "off" ? null : findExecutable("bwrap")
    if (settings.level !== "off" && bwrap === null) {
      return yield* Effect.fail(
        new InternalError({ message: "bwrap (bubblewrap) not found on PATH; run inside `nix develop` or `nix run .#box`" }),
      )
    }
    const systemdRun = yield* requireSystemdRun(settings)
    if (settings.systemd) yield* applyTaskLimits(settings.systemd, req.taskId)
    yield* Effect.forEach(
      [req.homeDir, req.mirrorDir],
      (dir) =>
        Effect.tryPromise({
          try: () => mkdir(dir, { recursive: true }),
          catch: (e) => new InternalError({ message: `cannot create ${dir}: ${String(e)}` }),
        }),
      { discard: true },
    )
    const home = agentHome(settings, req.homeDir)
    const hostPath = process.env.PATH ?? "/usr/bin:/bin"
    const env: Record<string, string> = {
      ...(settings.level === "off" ? platformEnv() : {}),
      PATH:
        settings.level === "strict"
          ? `${settings.binPath as string}:${SANDBOX_HOME}/${TOOLKIT_BIN}`
          : settings.level === "basic"
            ? `${hostPath}:${SANDBOX_HOME}/${TOOLKIT_BIN}`
            : `${hostPath}:${join(req.homeDir, TOOLKIT_BIN)}`,
      HOME: home,
      TERM: process.env.TERM ?? "xterm",
      ...(settings.sslCertFile
        ? { SSL_CERT_FILE: settings.sslCertFile, NIX_SSL_CERT_FILE: settings.sslCertFile }
        : {}),
      ...(req.display ? { DISPLAY: req.display, ...desktopScaleEnv } : {}),
      ...req.env,
    }

    const bwrapArgs = (level: "strict" | "basic"): string[] =>
      buildBwrapArgv({
        level,
        workspacePath: req.workspacePath,
        mirrorDir: req.mirrorDir,
        homeDir: req.homeDir,
        display: displayNumber(req.display),
        env,
        command: req.command,
        roBinds: req.roBinds,
        binds: req.binds,
        caBundle: settings.sslCertFile,
        homeToolArgs: level === "basic" ? boxHomeToolArgs() : [],
      }).slice(1)

    const inner: { file: string; args: string[] } =
      settings.level === "off"
        ? { file: shell(), args: ["-c", req.command] }
        : settings.level === "basic"
          ? { file: bwrap as string, args: bwrapArgs("basic") }
          : yield* Effect.map(
              taskNamespaces(settings, req.taskId, systemdRun),
              ({ holder, nsenter }) => {
                const [file, ...args] = joinTaskNet(nsenter, holder)
                return { file: file as string, args: [...args, bwrap as string, ...bwrapArgs("strict")] }
              },
            )

    if (settings.systemd === null) return { ...inner, env, cwd: req.workspacePath, home }

    return {
      file: systemdRun as string,
      args: [...scopeArgs(settings.systemd, req.taskId, req.kind), inner.file, ...inner.args],
      // systemd-run needs the user bus; bwrap's --clearenv keeps it out of the sandbox.
      env: { ...env, ...busEnv() },
      cwd: req.workspacePath,
      home,
    }
  })

/** Bytes kept at each end of a stream by `workspace_exec`; whatever lies between is counted, not held. */
const EXEC_WINDOW_BYTES = 10_000

/** A stream's first and last bytes, and the number of bytes dropped between them. */
export interface CapturedOutput {
  readonly head: string
  readonly tail: string
  readonly omittedBytes: number
}

export interface ProcessResult {
  /** -1 when the process ended by signal or was killed at the timeout. */
  readonly exitCode: number
  readonly timedOut: boolean
  readonly stdout: CapturedOutput
  readonly stderr: CapturedOutput
}

/** Pipe output still arriving once the main process has exited is read for this long, then the pipes are dropped. */
const DRAIN_GRACE_MS = 250

/** Holds the first and last `EXEC_WINDOW_BYTES` of a stream; the middle is counted and discarded as it arrives. */
class OutputWindow {
  private readonly head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer = Buffer.alloc(0)
  private omitted = 0

  push(chunk: Buffer): void {
    let rest = chunk
    if (this.headBytes < EXEC_WINDOW_BYTES) {
      const take = Math.min(EXEC_WINDOW_BYTES - this.headBytes, rest.length)
      this.head.push(Buffer.from(rest.subarray(0, take)))
      this.headBytes += take
      rest = rest.subarray(take)
    }
    if (rest.length === 0) return
    const joined = Buffer.concat([this.tail, rest])
    const excess = joined.length - EXEC_WINDOW_BYTES
    if (excess > 0) {
      this.omitted += excess
      this.tail = Buffer.from(joined.subarray(excess))
    } else {
      this.tail = joined
    }
  }

  result(): CapturedOutput {
    return {
      head: Buffer.concat(this.head).toString("utf8"),
      tail: this.tail.toString("utf8"),
      omittedBytes: this.omitted,
    }
  }
}

/**
 * Runs a process in its own process group and captures bounded output. A timeout kills the whole group and
 * returns what was printed, flagged `timedOut`. The result is reported once the main process has exited and
 * its pipes drained for a short grace: a backgrounded child that still holds the pipes is not waited for, so
 * its later writes to them fail (redirect its output to keep it running).
 */
export const runProcess = (
  file: string,
  args: ReadonlyArray<string>,
  opts: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Effect.Effect<ProcessResult, InternalError> =>
  Effect.async<ProcessResult, InternalError>((resume) => {
    let done = false
    let timedOut = false
    let exitCode = -1
    let timer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const stdout = new OutputWindow()
    const stderr = new OutputWindow()
    const settle = (effect: Effect.Effect<ProcessResult, InternalError>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      child.stdout.destroy()
      child.stderr.destroy()
      resume(effect)
    }
    const finish = () => settle(Effect.succeed({ exitCode, timedOut, stdout: stdout.result(), stderr: stderr.result() }))
    const drainThenFinish = () => {
      grace ??= setTimeout(finish, DRAIN_GRACE_MS)
    }
    const child = ownGroup(
      spawn(file, [...args], {
        cwd: opts.cwd,
        env: { ...opts.env },
        detached: NEW_PROCESS_GROUP,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessGroup(child.pid, "SIGKILL")
        drainThenFinish()
      }, opts.timeoutMs)
    }
    child.on("error", (err) => {
      settle(Effect.fail(new InternalError({ message: `${file} failed to start: ${err.message}` })))
    })
    child.once("exit", (code) => {
      exitCode = code ?? -1
      drainThenFinish()
    })
    child.on("close", (code) => {
      exitCode = code ?? -1
      finish()
    })
    return Effect.sync(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(grace)
      killProcessGroup(child.pid, "SIGKILL")
    })
  })

#!/usr/bin/env bun
/**
 * Capability-driven conformance check of a kestrel-box. By default it runs the agent path on a non-Nix Ubuntu 24.04
 * user box (basic sandbox) in Docker: agent CLIs installed under $HOME (Claude Code's native installer, Codex through
 * an npm prefix), as on WSL2 or the macOS VM. Needs docker. Build the binary first with `bun run build:box linux-x64`.
 *
 * Point it at an existing box instead with BOX_URL. It then skips the Docker setup and checks that box over HTTP:
 *
 * Usage: bun scripts/box-ubuntu/test.ts dist/box/kestrel-box-linux-x64 [--rebuild] [--keep]
 *        BOX_URL=https://box.example BOX_TOKEN=<box token> bun scripts/box-ubuntu/test.ts
 *        BOX_URL=https://box.example BOX_ID=<box id> BOX_SECRET=<box secret> BOX_USER=<login> bun scripts/box-ubuntu/test.ts
 *   --rebuild  rebuild kestrel-ubuntu-test:latest even when it exists (Docker mode)
 *   --keep     leave the container running for inspection (Docker mode)
 *
 * Checks desktop, encoder, GPU, toolkit, capacity and automation facts only where the box reports them; a fact the box
 * reports absent is SKIP with the reason. Exit: 0 all PASS/SKIP, 1 any FAIL, 2 harness error.
 */
import { openSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BOX_ID_HEADER, BOX_TOKEN_TTL_SECONDS, signBoxToken } from "../../packages/protocol/src/index"

const IMAGE = "kestrel-ubuntu-test:latest"
const HERE = import.meta.dir
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_S ?? 180) * 1000
const BOX_ID = "bx-test"
const BOX_SECRET = "s3cret-test"
const OWNER = "dev"
const BOX_PORT = 8787
const STUB_PORT = 9001
const STUB_SCRIPT = "/home/dev/control-stub.mjs"
const STUB_LOG = "/home/dev/control-stub.log"
const DATA_DIR = "/home/dev/.local/share/kestrel/box"
const BOX_LOG = "/home/dev/kestrel-box.log"
const BROKER_OK = /no anthropic credential is configured/i
const MISSING = /not found|execvp|No such file/i

const PLATFORMS = ["linux", "wsl", "lima", "other"] as const
const SANDBOXES = ["strict", "basic", "off"] as const
const DESKTOPS = ["prerequisites-present", "unavailable"] as const
const ENCODERS = ["nvenc", "x264", "none", "unknown"] as const
const GPU_RENDERING = ["hardware", "software", "none"] as const
const GPUS = ["none", "static", "on-demand"] as const
const DESKTOP_STATES = ["stopped", "starting", "running", "failed"] as const

/**
 * Control plane stand-in, run inside the container: the host's docker bridge gateway is not reachable from the
 * container on NixOS (host firewall), so the box talks to it over loopback instead. Answers only `/box/self`, and
 * only with the box's secret.
 */
const CONTROL_STUB = `import http from "node:http";
const SECRET = ${JSON.stringify(BOX_SECRET)}, BOX = ${JSON.stringify(BOX_ID)}, OWNER = ${JSON.stringify(OWNER)};
http.createServer((req, res) => {
  const authorized = req.headers.authorization === "Bearer " + SECRET;
  const boxId = req.headers["x-kestrel-box-id"];
  console.log(req.method + " " + req.url + " box=" + (boxId ?? "-") + " secret=" + (authorized ? "ok" : "bad"));
  res.setHeader("content-type", "application/json");
  if (req.method !== "GET" || req.url !== "/box/self") {
    res.statusCode = 404;
    return res.end(JSON.stringify({ _tag: "NotFound", message: "stub: no such route" }));
  }
  if (!authorized || boxId !== BOX) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ _tag: "Unauthorized", message: "stub: bad box secret" }));
  }
  res.end(JSON.stringify({ owner: OWNER, credentialsVersion: "0:" }));
}).listen(${STUB_PORT}, "127.0.0.1");
`

type Status = "PASS" | "FAIL" | "INFO" | "SKIP"
interface Row {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly errors: readonly string[]
}
interface Api {
  readonly status: number
  readonly text: string
  readonly json: unknown
}
type Rec = Record<string, unknown>
type Add = (name: string, status: Status, detail: string, errors?: readonly string[]) => void

class HarnessError extends Error {}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const positional = args.filter((a) => !a.startsWith("--"))
const boxUrl = (process.env.BOX_URL ?? "").trim().replace(/\/+$/, "")
if (boxUrl === "" && positional.length !== 1) {
  console.error("usage: bun test-box-ubuntu.ts <kestrel-box-linux-x64> [--rebuild] [--keep]")
  console.error("   or: BOX_URL=<url> BOX_TOKEN=<token> bun test-box-ubuntu.ts")
  console.error("   or: BOX_URL=<url> BOX_ID=<id> BOX_SECRET=<secret> BOX_USER=<login> bun test-box-ubuntu.ts")
  process.exit(2)
}
if (boxUrl !== "" && positional.length > 0) {
  console.error("BOX_URL selects the existing-box mode; do not also pass a local binary")
  process.exit(2)
}
const binary = positional[0] === undefined ? "" : resolve(positional[0]!)

const proc = async (cmd: string[], stdin?: string) => {
  const p = Bun.spawn(cmd, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}
const docker = (...a: string[]) => proc(["docker", ...a])
const boxExec = (name: string, ...cmd: string[]) => docker("exec", "-u", "dev", name, ...cmd)
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null
const oneOf = (v: unknown, allowed: readonly string[]): boolean => typeof v === "string" && allowed.includes(v)
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const lastLines = (text: string, pattern: RegExp | undefined, max: number): string[] => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
  const hits = pattern ? lines.filter((l) => pattern.test(l)) : lines
  return (hits.length > 0 ? hits : lines).slice(-max)
}

const ensureImage = async (rebuild: boolean): Promise<string> => {
  const exists = (await docker("image", "inspect", IMAGE)).code === 0
  if (exists && !rebuild) return "cached"
  const logFile = join(tmpdir(), "kestrel-ubuntu-test-build.log")
  const log = openSync(logFile, "w")
  const p = Bun.spawn(["docker", "build", "-t", IMAGE, HERE], { stdout: log, stderr: log })
  if ((await p.exited) !== 0) throw new HarnessError(`docker build failed; see ${logFile}`)
  return exists ? "rebuilt" : "built"
}

/** Problems with the required v1 fields and any optional capability field that is present. */
const capabilityProblems = (cap: Rec): string[] => {
  const problems: string[] = []
  if (cap.version !== 1) problems.push(`version is ${String(cap.version)}, not 1`)
  if (!oneOf(cap.platform, PLATFORMS)) problems.push(`platform is ${JSON.stringify(cap.platform)}`)
  if (!oneOf(cap.sandbox, SANDBOXES)) problems.push(`sandbox is ${JSON.stringify(cap.sandbox)}`)
  if (!oneOf(cap.desktop, DESKTOPS)) problems.push(`desktop is ${JSON.stringify(cap.desktop)}`)
  if (cap.harnesses !== undefined && !Array.isArray(cap.harnesses)) problems.push("harnesses is not an array")
  if (cap.modelHarnesses !== undefined && !Array.isArray(cap.modelHarnesses)) problems.push("modelHarnesses is not an array")
  if (cap.gpu !== undefined && !oneOf(cap.gpu, GPUS)) problems.push(`gpu is ${JSON.stringify(cap.gpu)}`)
  if (cap.suspend !== undefined && typeof cap.suspend !== "boolean") problems.push("suspend is not a boolean")
  if (cap.encoder !== undefined && !oneOf(cap.encoder, ENCODERS)) {
    problems.push(`encoder is ${JSON.stringify(cap.encoder)}`)
  }
  if (cap.gpuRendering !== undefined && !oneOf(cap.gpuRendering, GPU_RENDERING)) {
    problems.push(`gpuRendering is ${JSON.stringify(cap.gpuRendering)}`)
  }
  if (cap.toolkits !== undefined && !(Array.isArray(cap.toolkits) && cap.toolkits.every((n) => typeof n === "string"))) {
    problems.push("toolkits is not an array of strings")
  }
  if (cap.capacity !== undefined) {
    const runs = isRec(cap.capacity) ? cap.capacity.maxConcurrentRuns : undefined
    if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 0) {
      problems.push(`capacity.maxConcurrentRuns is ${JSON.stringify(runs)}`)
    }
  }
  if (cap.automations !== undefined && typeof cap.automations !== "boolean") {
    problems.push("automations is not a boolean")
  }
  return problems
}

interface Checks {
  readonly add: Add
  readonly api: (method: string, path: string, body?: unknown) => Promise<Api>
  /** The Docker fixture has no desktop tools and no credentials: it expects the broker's "no credential" answer. */
  readonly expectBroker: boolean
  /** Reads the box's run log; absent when the runner has no filesystem access to the box. */
  readonly readFile?: (path: string) => Promise<string>
}

/** The checks every box runs, plus capability-driven checks for the facts it reports. */
const runChecks = async ({ add, api, expectBroker, readFile }: Checks): Promise<void> => {
  const capabilities = await api("GET", "/api/capabilities")
  const cap = capabilities.json
  const problems = isRec(cap) ? capabilityProblems(cap) : [`capabilities is ${JSON.stringify(cap)}`]
  const capOk = capabilities.status === 200 && isRec(cap) && problems.length === 0
  const summary = isRec(cap)
    ? [
        `version=${String(cap.version)}`,
        `platform=${String(cap.platform)}`,
        `sandbox=${String(cap.sandbox)}`,
        `desktop=${String(cap.desktop)}`,
        ...(cap.encoder === undefined ? [] : [`encoder=${String(cap.encoder)}`]),
        ...(cap.gpuRendering === undefined ? [] : [`gpuRendering=${String(cap.gpuRendering)}`]),
        ...(cap.toolkits === undefined ? [] : [`toolkits=${JSON.stringify(cap.toolkits)}`]),
        ...(cap.capacity === undefined ? [] : [`capacity=${JSON.stringify(cap.capacity)}`]),
        ...(cap.automations === undefined ? [] : [`automations=${String(cap.automations)}`]),
      ].join(" ")
    : `${capabilities.status} ${capabilities.text}`
  add("GET /api/capabilities", capOk ? "PASS" : "FAIL", summary,
    problems.length > 0 ? problems : capOk ? [] : [capabilities.text])
  if (!isRec(cap)) return

  const desktop = oneOf(cap.desktop, DESKTOPS) ? cap.desktop : null
  const gpu = oneOf(cap.gpu, GPUS) ? cap.gpu : undefined

  // The encoder is what desktop video ends up on, as far as startup facts say. Unknown is a fact, not a failure.
  if (cap.encoder === undefined) {
    add("desktop encoder", "SKIP", "capability encoder not reported (older box)")
  } else if (cap.encoder === "none") {
    add("desktop encoder", "SKIP", "capability encoder=none (no desktop video)")
  } else if (cap.encoder === "unknown") {
    add("desktop encoder", "SKIP", "capability encoder=unknown (NVENC is not proven until a desktop starts)")
  } else {
    add("desktop encoder", "PASS", `capability encoder=${String(cap.encoder)}`)
  }

  if (cap.encoder !== undefined && desktop !== null) {
    const contradiction = desktop === "prerequisites-present"
      ? cap.encoder === "none" ? "desktop=prerequisites-present but encoder=none" : null
      : cap.encoder === "none" ? null : `desktop=unavailable but encoder=${String(cap.encoder)}`
    add("encoder vs desktop", contradiction === null ? "PASS" : "FAIL",
      contradiction ?? `encoder=${String(cap.encoder)} with desktop=${desktop}`,
      contradiction === null ? [] : [capabilities.text])
  }

  if (gpu === undefined) {
    add("GPU", "SKIP", "capability gpu not reported (older box)")
  } else if (gpu === "none") {
    add("GPU", "SKIP", "capability gpu=none")
  } else {
    add("GPU", "PASS", `capability gpu=${gpu}`)
  }

  if (cap.gpuRendering === undefined) {
    add("GPU rendering", "SKIP", "capability gpuRendering not reported (older box)")
  } else {
    const expected = desktop === null
      ? undefined
      : desktop !== "prerequisites-present"
        ? "none"
        : gpu === "static" || gpu === "on-demand"
          ? "hardware"
          : gpu === "none"
            ? "software"
            : undefined
    const ok = expected === undefined || expected === cap.gpuRendering
    add("GPU rendering", ok ? "PASS" : "FAIL",
      ok
        ? `capability gpuRendering=${String(cap.gpuRendering)}${gpu === undefined ? "" : ` (gpu=${gpu})`}`
        : `capability gpuRendering=${String(cap.gpuRendering)} but desktop=${String(cap.desktop)} and gpu=${String(cap.gpu)} imply ${expected}`,
      ok ? [] : [capabilities.text])
  }

  if (cap.toolkits === undefined) {
    add("toolkits", "SKIP", "capability toolkits not reported (older box)")
  } else if (!Array.isArray(cap.toolkits)) {
    add("toolkits", "SKIP", "capability toolkits is not an array (see capabilities FAIL)")
  } else if (cap.toolkits.length === 0) {
    add("toolkits", "SKIP", "capability toolkits=[] (no toolkit install)")
  } else {
    add("toolkits", "PASS", `toolkit_install can build ${cap.toolkits.map(String).join(", ")}`)
  }

  if (cap.capacity === undefined) {
    add("capacity", "SKIP", "capability capacity not reported (older box)")
  } else if (isRec(cap.capacity) && typeof cap.capacity.maxConcurrentRuns === "number") {
    const runs = cap.capacity.maxConcurrentRuns
    add("capacity", "PASS", runs === 0 ? "maxConcurrentRuns=0 (unlimited)" : `maxConcurrentRuns=${runs}`)
  } else {
    add("capacity", "SKIP", "capability capacity is malformed (see capabilities FAIL)")
  }

  if (cap.automations === undefined) {
    add("automations", "SKIP", "capability automations not reported (older box)")
  } else if (cap.automations === false) {
    add("automations", "SKIP", "capability automations=false (no control plane)")
  } else {
    add("automations", "PASS", "control plane present for automations and PR watches")
  }

  const cli = await api("GET", "/api/cli-auth")
  const cliList = Array.isArray(cli.json) ? cli.json.filter(isRec) : []
  if (cli.status === 200 && cliList.length > 0) {
    const providers = cliList.map((e) => String(e.provider))
    const ok = providers.includes("claude-cli") && providers.includes("codex-cli")
    add("GET /api/cli-auth", ok ? "PASS" : "FAIL",
      cliList.map((e) => `${String(e.provider)} loggedIn=${String(e.loggedIn)}`).join(", "))
  } else {
    const message = isRec(cli.json) ? String(cli.json.message) : cli.text
    add("GET /api/cli-auth", "FAIL", `${cli.status} ${message}`, [cli.text])
  }

  const task = await api("POST", "/api/tasks", {})
  const taskId = isRec(task.json) && typeof task.json.id === "string" ? task.json.id : undefined
  if (taskId === undefined) {
    add("POST /api/tasks", "FAIL", `${task.status} ${task.text}`, [task.text])
  } else {
    const sent = await api("POST", `/api/tasks/${taskId}/messages`, { text: "hi", model: "claude-sonnet-4-6" })
    const runId = isRec(sent.json) && isRec(sent.json.run) && typeof sent.json.run.id === "string"
      ? sent.json.run.id
      : undefined
    if (sent.status !== 200 || runId === undefined) {
      add("agent run (claude-sonnet-4-6)", "FAIL", `send message ${sent.status}`, [sent.text])
    } else {
      let run: Rec | undefined
      const deadline = Date.now() + RUN_TIMEOUT_MS
      while (Date.now() < deadline) {
        const runs = await api("GET", `/api/tasks/${taskId}/runs`)
        run = Array.isArray(runs.json) ? runs.json.filter(isRec).find((r) => r.id === runId) : undefined
        if (run && run.status !== "running") break
        await Bun.sleep(1000)
      }
      const items = await api("GET", `/api/runs/${runId}/items`)
      const outLog = readFile === undefined ? "" : await readFile(`${DATA_DIR}/runs/${runId}/output.log`)
      const evidence = [items.text, outLog].join("\n")
      const state = run
        ? `status=${String(run.status)} exit=${String(run.exitCode)} provider=${String(run.provider ?? "-")}`
        : "run not listed"
      if (!run || run.status === "running") {
        add("agent run (claude-sonnet-4-6)", "FAIL", `still running after ${RUN_TIMEOUT_MS / 1000}s`,
          lastLines(evidence, undefined, 6))
      } else if (expectBroker && BROKER_OK.test(evidence)) {
        add("agent run (claude-sonnet-4-6)", "PASS",
          `claude started in sandbox and reached the credential broker (${state})`, lastLines(evidence, BROKER_OK, 3))
      } else if (MISSING.test(evidence)) {
        add("agent run (claude-sonnet-4-6)", "FAIL", `claude not launchable in sandbox (${state})`,
          lastLines(evidence, MISSING, 4))
      } else if (expectBroker) {
        add("agent run (claude-sonnet-4-6)", "FAIL", `unexpected outcome (${state})`, lastLines(evidence, undefined, 6))
      } else if (run.status === "succeeded") {
        add("agent run (claude-sonnet-4-6)", "PASS", `agent run succeeded (${state})`, lastLines(evidence, undefined, 3))
      } else {
        add("agent run (claude-sonnet-4-6)", "FAIL", `run ended ${String(run.status)} (${state})`,
          lastLines(evidence, undefined, 6))
      }
    }
  }

  // Only a box that reports desktop prerequisites can be asked to start one; otherwise the check has nothing to prove.
  if (desktop !== "prerequisites-present") {
    add("desktop status", "SKIP", `capability desktop=${String(cap.desktop)}`)
  } else if (taskId === undefined) {
    add("desktop status", "SKIP", "no task to inspect")
  } else {
    const status = await api("GET", `/api/tasks/${taskId}/desktop`)
    const ok = status.status === 200 && isRec(status.json) && oneOf(status.json.state, DESKTOP_STATES)
    add("desktop status", ok ? "PASS" : "FAIL",
      ok ? `state=${String(status.json.state)} display=${String(status.json.display)}` : `${status.status} ${status.text}`,
      ok ? [] : [status.text])
  }
}

/** A token for an existing box: BOX_TOKEN, or one signed with the box's id and secret. */
const existingToken = async (): Promise<{ readonly token: string; readonly boxId: string | null }> => {
  const given = (process.env.BOX_TOKEN ?? "").trim()
  const id = (process.env.BOX_ID ?? "").trim() || null
  if (given !== "") return { token: given, boxId: id }
  const secret = (process.env.BOX_SECRET ?? "").trim()
  if (secret === "" || id === null) {
    throw new HarnessError("existing-box mode needs BOX_TOKEN, or BOX_ID and BOX_SECRET with BOX_USER")
  }
  const user = (process.env.BOX_USER ?? "").trim()
  if (user === "") {
    throw new HarnessError("BOX_ID + BOX_SECRET mode needs BOX_USER: the box owner's login, used as the token subject")
  }
  const now = Math.floor(Date.now() / 1000)
  const token = await signBoxToken(secret, {
    sub: user,
    aud: id,
    iat: now,
    exp: now + BOX_TOKEN_TTL_SECONDS,
    cv: (process.env.BOX_CV ?? "").trim() || "0:",
  })
  return { token, boxId: id }
}

const runExisting = async (add: Add): Promise<void> => {
  const { token, boxId } = await existingToken()
  const health = await fetch(`${boxUrl}/api/health`)
  add("GET /api/health", health.status === 200 ? "PASS" : "FAIL", `${health.status} ${await health.text()}`)
  if (health.status !== 200) throw new HarnessError(`box is not healthy: ${boxUrl}/api/health answered ${health.status}`)

  const api = async (method: string, path: string, body?: unknown): Promise<Api> => {
    const res = await fetch(`${boxUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(boxId === null ? {} : { [BOX_ID_HEADER]: boxId }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, text, json: parseJson(text) }
  }
  console.log(`existing box: ${boxUrl}`)
  await runChecks({ add, api, expectBroker: false })
}

const runDocker = async (add: Add, rows: Row[]): Promise<void> => {
  if (!(await Bun.file(binary).exists())) throw new HarnessError(`binary not found: ${binary}`)
  console.log(`image ${IMAGE}: ${await ensureImage(flags.has("--rebuild"))}`)

  const name = `kb-ubuntu-${crypto.randomUUID().slice(0, 8)}`
  let started = false
  try {
    const run = await docker(
      "run", "-d", "--name", name, "--privileged",
      "-p", `127.0.0.1::${BOX_PORT}`,
      "-v", `${binary}:/usr/local/bin/kestrel-box:ro`,
      IMAGE, "sleep", "infinity",
    )
    if (run.code !== 0) throw new HarnessError(`docker run failed: ${run.stderr.trim()}`)
    started = true
    const published = /127\.0\.0\.1:(\d+)/.exec((await docker("port", name, `${BOX_PORT}/tcp`)).stdout)
    if (!published) throw new HarnessError("docker port: no published port")
    const base = `http://127.0.0.1:${published[1]}`
    console.log(`container ${name}: box port ${BOX_PORT} -> ${base}`)

    const controlUrl = `http://127.0.0.1:${STUB_PORT}`
    await proc(["docker", "exec", "-i", "-u", "dev", name, "sh", "-c", `cat > ${STUB_SCRIPT}`], CONTROL_STUB)
    await docker("exec", "-d", "-u", "dev", name, "sh", "-c", `exec node ${STUB_SCRIPT} >${STUB_LOG} 2>&1`)
    let reachable = ""
    for (let i = 0; i < 20 && reachable !== "200"; i++) {
      reachable = (await boxExec(name, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "2",
        "-H", `Authorization: Bearer ${BOX_SECRET}`, "-H", `x-kestrel-box-id: ${BOX_ID}`,
        `${controlUrl}/box/self`)).stdout.trim()
      if (reachable !== "200") await Bun.sleep(250)
    }
    add("preflight: box -> control stub", reachable === "200" ? "PASS" : "FAIL",
      `curl ${controlUrl}/box/self in container: HTTP ${reachable || "no response"}`)

    const config = {
      controlUrl,
      boxId: BOX_ID,
      boxSecret: BOX_SECRET,
      port: BOX_PORT,
      dataDir: "~/.local/share/kestrel/box",
      sandbox: "basic",
      provisioning: {
        mode: "guaranteed",
        taskMemoryMin: "1G",
        taskCpuWeight: 100,
        taskMemoryMax: "4G",
        taskCpuQuota: "200%",
        taskTasksMax: 1024,
        taskDiskMax: "50G",
        boxMemoryMax: "80%",
        boxCpuQuota: null,
        maxConcurrentRuns: null,
      },
    }
    await proc(["docker", "exec", "-i", "-u", "dev", name, "sh", "-c",
      "mkdir -p ~/.config/kestrel-box && cat > ~/.config/kestrel-box/config.json && chmod 600 ~/.config/kestrel-box/config.json"],
      JSON.stringify(config, null, 2))

    // Before the box starts, so its port check reflects the box's own bind rather than a running instance.
    const doctor = await boxExec(name, "kestrel-box", "doctor")
    const doctorOut = `${doctor.stdout}${doctor.stderr}`.trimEnd()
    const doctorFails = doctorOut.split("\n").filter((l) => l.startsWith("FAIL"))
    add("kestrel-box doctor (info)", "INFO",
      `exit ${doctor.code}; ${doctorFails.length} required check(s) FAIL (full output below)`, doctorFails)
    console.log(`\n--- kestrel-box doctor (exit ${doctor.code}) ---\n${doctorOut}\n---`)

    // CLOUDAGENTS_HOST=0.0.0.0: the box binds loopback by default, which docker's published port cannot reach.
    await docker("exec", "-d", "-u", "dev",
      "-e", "CLOUDAGENTS_SYSTEMD=0", "-e", "CLOUDAGENTS_HOST=0.0.0.0",
      name, "sh", "-c", `kestrel-box run >${BOX_LOG} 2>&1`)

    let healthy = false
    for (let i = 0; i < 120 && !healthy; i++) {
      healthy = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)
      if (!healthy) await Bun.sleep(500)
    }
    if (!healthy) {
      const log = (await boxExec(name, "tail", "-n", "40", BOX_LOG)).stdout
      throw new HarnessError(`box did not become healthy within 60s; log tail:\n${log}`)
    }

    const now = Math.floor(Date.now() / 1000)
    const token = await signBoxToken(BOX_SECRET, {
      sub: OWNER, aud: BOX_ID, iat: now, exp: now + BOX_TOKEN_TTL_SECONDS, cv: "0:",
    })
    const api = async (method: string, path: string, body?: unknown): Promise<Api> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          [BOX_ID_HEADER]: BOX_ID,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, text, json: parseJson(text) }
    }

    const health = await fetch(`${base}/api/health`)
    add("GET /api/health", health.status === 200 ? "PASS" : "FAIL", `${health.status} ${await health.text()}`)

    await runChecks({
      add,
      api,
      expectBroker: true,
      readFile: async (path) => {
        const log = await boxExec(name, "cat", path)
        return `${log.stdout}${log.stderr}`
      },
    })

    const stubHits = (await boxExec(name, "cat", STUB_LOG)).stdout.trim().split("\n").filter((l) => l !== "")
    add("box reached control plane", stubHits.some((l) => l.includes("secret=ok")) ? "PASS" : "FAIL",
      `${stubHits.length} stub request(s); last: ${stubHits.at(-1) ?? "none"}`)

    if (rows.some((r) => r.status === "FAIL")) {
      const boxLog = (await boxExec(name, "tail", "-n", "400", BOX_LOG)).stdout
      console.log(`\n--- box log (relevant lines) ---\n${lastLines(boxLog, /error|unreadable|not found|execvp|No such file|credential|failed/i, 12).join("\n")}`)
    }
  } finally {
    if (started && flags.has("--keep")) console.log(`container kept: ${name}`)
    if (started && !flags.has("--keep")) await docker("rm", "-f", name)
  }
}

const main = async (): Promise<number> => {
  const rows: Row[] = []
  const add: Add = (name, status, detail, errors = []) => rows.push({ name, status, detail, errors })
  if (boxUrl === "") await runDocker(add, rows)
  else await runExisting(add)

  const width = Math.max(...rows.map((r) => r.name.length))
  console.log(`\n${"CHECK".padEnd(width)}  RESULT  DETAIL`)
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.status.padEnd(6)}  ${r.detail}`)
  const failed = rows.filter((r) => r.status === "FAIL")
  const skipped = rows.filter((r) => r.status === "SKIP")
  for (const r of failed) {
    console.log(`\n[FAIL] ${r.name} error text:`)
    for (const line of r.errors.length > 0 ? r.errors : ["(none)"]) console.log(`    ${line}`)
  }
  console.log(`\n${failed.length === 0
    ? (skipped.length === 0 ? "ALL PASS" : `ALL PASS (${skipped.length} skipped)`)
    : `${failed.length} FAIL`}`)
  return failed.length === 0 ? 0 : 1
}

try {
  process.exit(await main())
} catch (error) {
  console.error(error instanceof HarnessError ? `harness error: ${error.message}` : error)
  process.exit(2)
}

/**
 * `bun run dev`: the whole local stack in one terminal, on Linux, macOS and Windows: the Worker control plane
 * (`wrangler dev`, dev sign-in), a box connected to it, and Vite. `nix run` runs this with the Nix toolchain,
 * which is what turns the agent sandbox on.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../packages/server/src/process"
import { provisionDevFleetBox } from "../packages/server/src/dev/fleet"

const root = join(import.meta.dir, "..")
const env = process.env
const WINDOWS = process.platform === "win32"
const STOP_GRACE_MS = 5_000

const fail = (message: string): never => {
  console.error(`dev: ${message}`)
  process.exit(1)
}

// Several people (and several worktrees per person) can run this on one machine. Each Linux user gets a block of
// 100 ports above uid 1000; KESTREL_DEV_SLOT (0-9) picks a sub-block of 10 inside it, one per worktree running at
// the same time. Windows has no uid, so only the slot counts there. The box never takes 8787, which belongs to the
// production box.
const slot = Number(env.KESTREL_DEV_SLOT || "0")
if (!Number.isInteger(slot) || slot < 0 || slot > 9) fail(`KESTREL_DEV_SLOT must be 0-9, got "${env.KESTREL_DEV_SLOT}"`)
const uid = process.getuid?.() ?? 0
const offset = Number(env.KESTREL_DEV_OFFSET || (uid >= 1000 ? (uid - 1000) * 100 : 0) + slot * 10)
if (!Number.isInteger(offset) || offset < 0) fail(`KESTREL_DEV_OFFSET must be a non-negative integer, got "${env.KESTREL_DEV_OFFSET}"`)
const controlPort = 8788 + offset
const appPort = 5173 + offset
const boxPort = env.CLOUDAGENTS_PORT || String(8797 + offset)

const varsPath = join(root, "packages/control/.dev.vars")
if (!existsSync(varsPath)) {
  const token = randomBytes(32).toString("hex")
  writeFileSync(varsPath, `BOX_TOKEN=${token}\nDEV_SESSION_LOGIN=dev\nKESTREL_OPERATORS=dev\n`)
  console.log(`dev: created ${varsPath} (dev sign-in as 'dev')`)
}
const varsText = readFileSync(varsPath, "utf8")
const boxToken = /^BOX_TOKEN=(.+)$/m.exec(varsText)?.[1]?.trim() ?? fail(`no BOX_TOKEN in ${varsPath}`)
const devLogin = /^DEV_SESSION_LOGIN=(.+)$/m.exec(varsText)?.[1]?.trim() ?? fail(`no DEV_SESSION_LOGIN in ${varsPath}`)
// The dev sign-in must be an operator to manage the dev managed box. Files made before that existed get the line.
const operators = /^KESTREL_OPERATORS=(.*)$/m.exec(varsText)?.[1]
if (operators === undefined) {
  appendFileSync(varsPath, `${varsText.endsWith("\n") ? "" : "\n"}KESTREL_OPERATORS=${devLogin}\n`)
} else if (!operators.split(/[\s,]+/).includes(devLogin)) {
  fail(`add ${devLogin} to KESTREL_OPERATORS in ${varsPath}`)
}

const bun = process.execPath
// The Worker serves packages/app/dist; Vite serves the live app on its own port.
if (!existsSync(join(root, "packages/app/dist"))) {
  const build = spawnSync(bun, ["run", "build:app"], { cwd: root, stdio: "inherit" })
  if (build.status !== 0) fail("bun run build:app failed")
}

const dataDir = env.CLOUDAGENTS_DEV_DATA_DIR || join(root, ".data-dev")
const boxEnv: Record<string, string> = {
  CLOUDAGENTS_PORT: boxPort,
  // Separate from a production box on the same machine.
  CLOUDAGENTS_DATA_DIR: dataDir,
  CLOUDAGENTS_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
  CLOUDAGENTS_BOX_TOKEN: boxToken,
}
// The strict sandbox needs the Nix toolchain (CLOUDAGENTS_SANDBOX_PATH, set by the flake) and Linux. Without it agents
// run unsandboxed unless the caller decided otherwise.
if (!env.CLOUDAGENTS_SANDBOX_PATH && env.CLOUDAGENTS_SANDBOX === undefined) {
  boxEnv.CLOUDAGENTS_SANDBOX = "off"
  console.warn("dev: no Nix toolchain (CLOUDAGENTS_SANDBOX_PATH): agents run UNSANDBOXED on this machine")
}
// Resource limits are systemd scopes, which only exist on Linux.
if (process.platform !== "linux" && env.CLOUDAGENTS_SYSTEMD === undefined) boxEnv.CLOUDAGENTS_SYSTEMD = "0"

interface Proc {
  readonly name: string
  readonly child: ChildProcess
}

const procs: Proc[] = []
let stopping = false

const running = (p: Proc) => p.child.exitCode === null && p.child.signalCode === null

const exited = (p: Proc, ms: number): Promise<void> => {
  if (!running(p)) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  p.child.once("exit", () => {
    clearTimeout(timer)
    resolve()
  })
  return promise
}

/**
 * Stops every process tree, then exits. On Ctrl+C in Windows the console has already sent the interrupt to every
 * child, so they get the grace period before being killed; elsewhere they are signalled here.
 */
const stop = async (code: number, interrupted: boolean) => {
  if (stopping) return
  stopping = true
  if (!(interrupted && WINDOWS)) for (const p of procs) if (running(p)) killProcessGroup(p.child.pid, "SIGINT")
  await Promise.all(procs.map((p) => exited(p, STOP_GRACE_MS)))
  for (const p of procs) if (running(p)) killProcessGroup(p.child.pid, "SIGKILL")
  process.exit(code)
}

const start = (name: string, cwd: string, command: string, args: readonly string[], extraEnv: Record<string, string> = {}) => {
  const child = ownGroup(
    spawn(command, args, {
      cwd: join(root, cwd),
      env: { ...env, FORCE_COLOR: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      detached: NEW_PROCESS_GROUP,
      windowsHide: true,
    }),
  )
  const p: Proc = { name, child }
  procs.push(p)
  const tag = `[${name}]`.padEnd(9)
  createInterface({ input: child.stdout! }).on("line", (line) => console.log(`${tag}${line}`))
  createInterface({ input: child.stderr! }).on("line", (line) => console.error(`${tag}${line}`))
  child.on("error", (e) => {
    console.error(`dev: ${name} could not start: ${e.message}`)
    void stop(1, false)
  })
  child.on("exit", (code, signal) => {
    if (stopping) return
    console.error(`dev: ${name} exited (${code ?? signal}); stopping the stack`)
    void stop(code || 1, false)
  })
}

process.on("SIGINT", () => void stop(0, true))
process.on("SIGTERM", () => void stop(0, false))
// The children lead their own process groups, so a closed terminal reaches only this script.
process.on("SIGHUP", () => void stop(0, false))

// KESTREL_WRANGLER: the flake's wrangler, because the npm workerd binary does not run on NixOS.
const [wrangler, ...wranglerArgs] = env.KESTREL_WRANGLER ? [env.KESTREL_WRANGLER] : [bun, "x", "wrangler"]
start("worker", "packages/control", wrangler!, [
  ...wranglerArgs,
  "dev",
  "--port",
  String(controlPort),
  "--inspector-port",
  String(9229 + offset),
  "--ip",
  "127.0.0.1",
  "--var",
  `APP_ORIGIN:http://localhost:${appPort}`,
])
// The dev stack also runs one managed box next to the legacy relay: both run in the same box process, which is how a
// production box cuts over. The Worker's dev sign-in is an operator, so it registers and activates the box itself.
const fleet = await provisionDevFleetBox({
  workerUrl: `http://127.0.0.1:${controlPort}`,
  boxUrl: `http://127.0.0.1:${boxPort}`,
  name: "dev",
  savedFile: join(dataDir, "dev-fleet-box.json"),
}).catch(async (error: unknown) => {
  console.error(`dev: ${error instanceof Error ? error.message : String(error)}`)
  await stop(1, false)
  return process.exit(1)
})
start("box", "packages/server", bun, ["run", "dev"], {
  ...boxEnv,
  CLOUDAGENTS_BOX_ID: fleet.id,
  CLOUDAGENTS_BOX_SECRET: fleet.secret,
  CLOUDAGENTS_BOX_MANAGED: "1",
})
start("app", "packages/app", bun, ["run", "dev"], {
  KESTREL_CONTROL_PORT: String(controlPort),
  KESTREL_APP_PORT: String(appPort),
})

console.log(`dev: ports: app ${appPort}, worker ${controlPort}, box ${boxPort}`)
console.log(`dev: open http://localhost:${appPort}/auth/dev-login to sign in`)

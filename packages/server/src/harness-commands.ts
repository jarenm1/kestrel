import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import type { HarnessCommand } from "@cloudagents/protocol"
import { CODEX_COMMANDS } from "./core/codex-app-server"
import { VERSION } from "./config"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "./process"

/*
 * Real command discovery from the authenticated agent CLIs, in the thread's own workspace.
 *
 * Claude Code exposes its slash commands (built-ins, bundled skills, user/project commands and skills) in the
 * control response to an `initialize` request on its stream-json interface. Codex's slash commands drive its
 * terminal UI; the ones a Kestrel run carries out over app-server are `CODEX_COMMANDS`, listed with the workspace's
 * enabled skills from app-server's `skills/list`. Both launches are bounded: whatever the CLI starts is killed with
 * its process group on answer, error or timeout, so discovery never leaves a child behind.
 */

/** How to start a CLI: the executable (possibly bwrap), its args, its exact env and the working directory. */
export interface DiscoveryLaunch {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

/**
 * Args that put Claude Code into stream-json control mode without starting a turn. `disableAllHooks` keeps the
 * workspace's own `.claude/settings.json` hooks from running during discovery: they are repo-controlled code that
 * would otherwise fire on a keystroke, outside any turn. Project commands and skills are still listed (`--bare`
 * and `--setting-sources` would drop them).
 */
export const CLAUDE_DISCOVERY_ARGS: ReadonlyArray<string> = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  '{"disableAllHooks":true}',
]

/** Codex app-server over stdio (its default transport). */
export const CODEX_DISCOVERY_ARGS: ReadonlyArray<string> = ["app-server"]

const TIMEOUT_MS = 15_000
const MAX_COMMANDS = 200
const DESCRIPTION_MAX = 600
const HINT_MAX = 120
/** A discovery CLI's whole answer is bounded; a runaway or compromised CLI cannot grow the box's heap. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
/** A command name has to survive being typed after the provider's prefix; keep it one token. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
/** CLIs add the source of a command to its description; that is not part of what the command does. */
const SOURCE_SUFFIX = /\s+\((?:bundled|user|project|plugin|mcp|local)\)$/i

/** Children still running, so a box exit cannot orphan a discovery process. */
const active = new Set<number>()
process.on("exit", () => {
  for (const pid of active) killProcessGroup(pid, "SIGKILL")
})

/** Kills every discovery child now (box shutdown); a running request then fails as interrupted. */
export const killActiveDiscovery = (): void => {
  for (const pid of [...active]) {
    active.delete(pid)
    killProcessGroup(pid, "SIGKILL")
  }
}

/**
 * A bounded process pool: a start runs at once while a slot is free, otherwise it waits in FIFO order. A finished
 * child hands its slot straight to the next waiter; a full queue fails fast.
 */
const processSlots = (
  maxRunning: number,
  maxQueued: number,
  busy: string,
): (<A>(start: () => Promise<A>) => Promise<A>) => {
  let running = 0
  const queued: Array<() => void> = []
  return <A>(start: () => Promise<A>): Promise<A> => {
    const run = () =>
      start().finally(() => {
        const next = queued.shift()
        if (next === undefined) running--
        else next()
      })
    if (running < maxRunning) {
      running++
      return run()
    }
    if (queued.length >= maxQueued) return Promise.reject(new Error(busy))
    const turn = Promise.withResolvers<void>()
    queued.push(() => turn.resolve())
    return turn.promise.then(run)
  }
}

/** Processes allowed to run at once in each pool; more wait in a queue, and a full queue fails fast. */
const MAX_RUNNING = 4
const MAX_QUEUED = 32

/** Discovery children: no more than MAX_RUNNING exist at once, whichever user or thread asked for them. */
export const limitDiscovery = processSlots(MAX_RUNNING, MAX_QUEUED, "command discovery is busy; try again")

/**
 * Status probes and the sign-in commands the user waits on (sign-out, key import, credential export). Their own
 * pool keeps a discovery child from delaying them, while still bounding how many such CLIs run at once.
 */
export const limitCliProbe = processSlots(MAX_RUNNING, MAX_QUEUED, "CLI probes are busy; try again")

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : ""

const commandName = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const name = value.trim().replace(/^[/$]+/, "")
  return NAME_PATTERN.test(name) ? name : null
}

/** Commands from one CLI payload, deduped by name, in the CLI's own order, typed with `prefix`. */
const toCommands = (rows: Iterable<unknown>, prefix: "/" | "$"): ReadonlyArray<HarnessCommand> => {
  const seen = new Set<string>()
  const commands: HarnessCommand[] = []
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue
    const record = row as Record<string, unknown>
    const name = commandName(record.name)
    if (name === null || seen.has(name)) continue
    seen.add(name)
    const description = cleanText(record.description, DESCRIPTION_MAX).replace(SOURCE_SUFFIX, "").trim()
    const argumentHint = cleanText(record.argumentHint, HINT_MAX)
    commands.push({ name, description, ...(argumentHint === "" ? {} : { argumentHint }), prefix })
    if (commands.length >= MAX_COMMANDS) break
  }
  return commands
}

/** Parses the `commands` array of a Claude Code initialize control response. */
export const parseClaudeCommands = (value: unknown): ReadonlyArray<HarnessCommand> =>
  Array.isArray(value) ? toCommands(value, "/") : []

/** Parses one Codex app-server `skills/list` result. Only enabled skills are exposed; their paths stay on the box. */
export const parseCodexSkills = (value: unknown): ReadonlyArray<HarnessCommand> => {
  if (typeof value !== "object" || value === null) return []
  const data = (value as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  const skills: unknown[] = []
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue
    const list = (entry as Record<string, unknown>).skills
    if (!Array.isArray(list)) continue
    for (const skill of list) {
      if (typeof skill !== "object" || skill === null) continue
      if ((skill as Record<string, unknown>).enabled === false) continue
      skills.push(skill)
    }
  }
  return toCommands(skills, "$")
}

/** Returns a result when the handler has the answer, undefined to keep reading, and throws on a refusal. */
type MessageHandler<A> = (message: unknown) => A | undefined

/**
 * Runs one discovery child under a timeout and kills its whole process group whichever way it ends.
 * `setup` writes the requests and returns the reader for the CLI's JSON lines.
 */
export const discover = <A>(
  launch: DiscoveryLaunch,
  label: string,
  timeoutMs: number,
  setup: (send: (message: unknown) => void) => MessageHandler<A>,
): Promise<A> => {
  const { promise, resolve, reject } = Promise.withResolvers<A>()
  let child: ChildProcess
  try {
    child = ownGroup(
      spawn(launch.file, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: NEW_PROCESS_GROUP,
        windowsHide: true,
      }),
    )
  } catch {
    reject(new Error(`${label} could not be started`))
    return promise
  }
  if (child.pid !== undefined) active.add(child.pid)
  const stdout = child.stdout
  const stdin = child.stdin
  if (stdout === null || stdin === null) {
    if (child.pid !== undefined) {
      active.delete(child.pid)
      killProcessGroup(child.pid, "SIGKILL")
    }
    reject(new Error(`${label} could not be started`))
    return promise
  }
  const lines = createInterface({ input: stdout })
  let done = false
  let timer: NodeJS.Timeout | undefined
  const finish = (action: () => void) => {
    if (done) return
    done = true
    clearTimeout(timer)
    lines.close()
    // Data listeners go; error listeners stay, so an error emitted after the answer cannot become an unhandled throw.
    stdout.removeAllListeners()
    stdout.on("error", () => {})
    child.stderr?.removeAllListeners()
    child.stderr?.on("error", () => {})
    // Only this discovery's listeners go: `ownGroup` keeps its own `exit` listener, which releases the process group's
    // handle once the child really exits. Removing every listener would leak one job object per discovery on Windows.
    child.off("error", startFailed)
    child.off("close", exitedBeforeAnswer)
    child.on("error", () => {})
    stdin.on("error", () => {})
    stdin.end()
    if (child.pid !== undefined) {
      active.delete(child.pid)
      killProcessGroup(child.pid, "SIGKILL")
    }
    action()
  }
  const fail = (message: string) => finish(() => reject(new Error(message)))
  const startFailed = () => fail(`${label} could not be started`)
  const exitedBeforeAnswer = () => fail(`${label} exited before answering`)
  timer = setTimeout(() => fail(`${label} timed out`), timeoutMs)
  child.once("error", startFailed)
  // stderr is drained so the CLI never blocks on a full pipe; it is not surfaced (it can name box paths).
  child.stderr?.on("data", () => {})
  child.once("close", exitedBeforeAnswer)
  stdin.on("error", () => {})
  const send = (message: unknown) => {
    if (done) return
    try {
      stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      fail(`${label} stopped before answering`)
    }
  }
  const handle = setup(send)
  // The whole answer is bounded before any line is parsed; `runDiscoveryCommand` caps its document the same way.
  let received = 0
  stdout.on("data", (chunk: string | Buffer) => {
    if (done) return
    received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
    if (received > MAX_OUTPUT_BYTES) fail(`${label} printed too much`)
  })
  lines.on("line", (line) => {
    if (done) return
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    try {
      const value = handle(message)
      if (value !== undefined) finish(() => resolve(value))
    } catch (error) {
      fail(error instanceof Error ? error.message : `${label} failed`)
    }
  })
  return promise
}

/**
 * Runs a discovery CLI that answers with one plain-text or JSON document rather than JSONL: OpenCode's model list.
 * Bounded like `discover`, with stdout alone collected (stderr can name box paths) and the whole process group killed
 * however it ends.
 */
export const runDiscoveryCommand = (
  launch: DiscoveryLaunch,
  label: string,
  timeoutMs: number,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> => {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let child: ChildProcess
  try {
    child = ownGroup(
      spawn(launch.file, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: NEW_PROCESS_GROUP,
        windowsHide: true,
      }),
    )
  } catch {
    reject(new Error(`${label} could not be started`))
    return promise
  }
  if (child.pid !== undefined) active.add(child.pid)
  const stdout = child.stdout
  if (stdout === null) {
    if (child.pid !== undefined) {
      active.delete(child.pid)
      killProcessGroup(child.pid, "SIGKILL")
    }
    reject(new Error(`${label} could not be started`))
    return promise
  }
  let done = false
  let timer: NodeJS.Timeout | undefined
  let output = ""
  const finish = (action: () => void) => {
    if (done) return
    done = true
    clearTimeout(timer)
    stdout.removeAllListeners()
    stdout.on("error", () => {})
    child.stderr?.removeAllListeners()
    child.stderr?.on("error", () => {})
    child.off("error", startFailed)
    child.off("close", closed)
    child.on("error", () => {})
    if (child.pid !== undefined) {
      active.delete(child.pid)
      killProcessGroup(child.pid, "SIGKILL")
    }
    action()
  }
  const fail = (message: string) => finish(() => reject(new Error(message)))
  const startFailed = () => fail(`${label} could not be started`)
  const closed = () => finish(() => resolve(output))
  timer = setTimeout(() => fail(`${label} timed out`), timeoutMs)
  child.once("error", startFailed)
  child.stderr?.on("data", () => {})
  child.once("close", closed)
  stdout.setEncoding("utf8")
  stdout.on("data", (chunk: string) => {
    if (done) return
    output += chunk
    if (output.length > maxBytes) fail(`${label} printed too much`)
  })
  return promise
}

/**
 * Claude Code: ask the session for its initialize payload. The control response lists every command that works
 * without an interactive terminal, with the CLI's own descriptions and argument hints. No model turn and no auth.
 */
export const discoverClaudeCommands = (
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<ReadonlyArray<HarnessCommand>> => {
  const requestId = `kestrel-commands-${process.pid}-${Date.now()}`
  return discover<ReadonlyArray<HarnessCommand>>(launch, "claude command discovery", timeoutMs, (send) => {
    send({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })
    return (message) => {
      if (typeof message !== "object" || message === null) return undefined
      const record = message as Record<string, unknown>
      if (record.type !== "control_response" || typeof record.response !== "object" || record.response === null) {
        return undefined
      }
      const response = record.response as Record<string, unknown>
      if (response.request_id !== requestId) return undefined
      if (response.subtype !== "success") throw new Error("claude command discovery was refused")
      const payload = response.response
      if (typeof payload !== "object" || payload === null) throw new Error("claude command discovery returned no payload")
      return parseClaudeCommands((payload as Record<string, unknown>).commands)
    }
  })
}

/**
 * Codex: its commands, then the enabled skills app-server lists for the thread workspace (`$name` in a prompt).
 * Skill paths are dropped here.
 */
export const discoverCodexCommands = (
  launch: DiscoveryLaunch,
  timeoutMs = TIMEOUT_MS,
): Promise<ReadonlyArray<HarnessCommand>> =>
  discover<ReadonlyArray<HarnessCommand>>(launch, "codex command discovery", timeoutMs, (send) => {
    const initializeId = 1
    const skillsId = 2
    send({
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: { name: "kestrel", title: "Kestrel", version: VERSION },
        capabilities: { experimentalApi: true },
      },
    })
    return (message) => {
      if (typeof message !== "object" || message === null) return undefined
      const record = message as Record<string, unknown>
      if (record.id === initializeId) {
        if (record.error !== undefined) throw new Error("codex command discovery could not initialize")
        send({ method: "initialized", params: {} })
        send({ method: "skills/list", id: skillsId, params: { cwds: [launch.cwd], forceReload: true } })
        return undefined
      }
      if (record.id !== skillsId) return undefined
      if (record.error !== undefined) throw new Error("codex command discovery could not list skills")
      return [...CODEX_COMMANDS, ...parseCodexSkills(record.result)]
    }
  })

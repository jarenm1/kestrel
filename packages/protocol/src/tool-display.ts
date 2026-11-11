import type { AgentItem } from "./index"
import { toolDisplayName } from "./tool-names"

export type ToolItem = Extract<AgentItem, { _tag: "tool" }>

/** What a call does, for its icon and for summing up a run of calls ("Ran 3 commands, read 2 files"). */
export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "desktop" | "agent" | "plan" | "other"

/** Icons beyond the kind's own: desktop actions by what they do, and Kestrel's own tools. */
export type ToolIcon = "camera" | "pointer" | "keyboard" | "git" | "message"

export interface EditLine {
  readonly kind: "context" | "add" | "del"
  readonly text: string
}

export interface ToolView {
  readonly kind: ToolKind
  readonly icon?: ToolIcon
  /** One line for the collapsed row. */
  readonly label: string
  /** The label is a shell command: shown in monospace. */
  readonly code: boolean
  /** The command as the details show it (unwrapped, store paths dropped). */
  readonly command?: string
  /** The command exactly as the harness reported it. */
  readonly rawCommand?: string
  /** Files the call wrote, for counting distinct files across a group. */
  readonly paths: readonly string[]
  readonly added?: number
  readonly removed?: number
  /** Line diff of an edit or write, when the input carries the text. */
  readonly diff?: readonly EditLine[]
  /** Codex file changes: no text, only what happened to each path. */
  readonly changes?: ReadonlyArray<{ readonly path: string; readonly kind: string }>
  readonly todos?: ReadonlyArray<{ readonly text: string; readonly status: string }>
  /** Longer free text the details show above the output (a subagent's prompt, a report's message). */
  readonly note?: string
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** `/nix/store/<hash>-<name>/bin/`: the sandbox toolchain's absolute paths, which say nothing the program name doesn't. */
const NIX_BIN = /\/nix\/store\/[0-9a-z]{32}-[^/\s'"]+\/bin\//g
const SHELLS: Readonly<Record<string, true>> = { sh: true, bash: true, zsh: true, dash: true }

/**
 * Splits a simple command into words, honouring quotes and backslashes. Null when it is not one simple command
 * (pipes, `&&`, redirections, subshells, unterminated quotes): those are shown as they are.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = []
  let word = ""
  let inWord = false
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return null
      word += command.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1]!)) i++
        word += command[i]
        i++
      }
      if (i >= command.length) return null
      inWord = true
      i++
    } else if (c === "\\") {
      if (i + 1 >= command.length) return null
      word += command[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
      i++
    } else if (";&|<>()`".includes(c)) {
      return null
    } else {
      word += c
      inWord = true
      i++
    }
  }
  if (inWord) words.push(word)
  return words
}

/**
 * The command the agent meant: `<shell> [-l] -c '<script>'` becomes the script, and toolchain store paths become
 * bare program names. A wrapper with anything after the script (positional arguments) is kept whole.
 */
export function displayCommand(command: string): string {
  const trimmed = command.replace(NIX_BIN, "").trim()
  const words = shellWords(trimmed)
  const program = words?.[0]?.split("/").at(-1)
  if (words === null || program === undefined || !Object.hasOwn(SHELLS, program)) return trimmed
  const flag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word))
  if (flag === -1 || words.slice(1, flag).some((word) => !word.startsWith("-")) || flag + 2 !== words.length) {
    return trimmed
  }
  return displayCommand(words[flag + 1]!)
}

const SANDBOX_HOME = "/home/agent"

/**
 * A path as the user knows it: relative to the thread's workspace (`<data>/threads/<taskId>`), or `~` for the agent's
 * home. Backslashes count as separators too (a dev box on Windows).
 */
export function displayToolPath(path: string, taskId: string): string {
  const normalized = path.replaceAll("\\", "/")
  const workspace = `/threads/${taskId}`
  const at = normalized.indexOf(workspace)
  if (at !== -1) {
    const rest = normalized.slice(at + workspace.length)
    if (rest === "" || rest === "/") return "."
    if (rest.startsWith("/")) return rest.slice(1)
  }
  if (normalized === SANDBOX_HOME || normalized.startsWith(`${SANDBOX_HOME}/`)) return `~${normalized.slice(SANDBOX_HOME.length)}`
  return path
}

/** Absolute workspace paths inside a command, made relative (the command runs in the workspace). */
function commandPaths(command: string, taskId: string): string {
  const id = taskId.replace(/[^\w-]/g, "\\$&")
  return command.replace(new RegExp(`[^\\s'"=]*[/\\\\]threads[/\\\\]${id}(?=[/\\\\\\s'"]|$)`, "g"), ".")
}

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

/** Longest-common-subsequence size cap; past it an edit shows as all-removed then all-added. */
const DIFF_CELLS = 250_000

/** Line diff of one replacement: common lines as context, the rest removed/added. */
export function editDiff(before: string, after: string): EditLine[] {
  const a = lines(before)
  const b = lines(after)
  if (a.length * b.length > DIFF_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))]
  }
  // lcs[i][j]: common lines of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: EditLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! })
      i++
      j++
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // On a tie the removal goes first, as in a unified diff.
      out.push({ kind: "del", text: a[i]! })
      i++
    } else {
      out.push({ kind: "add", text: b[j]! })
      j++
    }
  }
  return out
}

const counts = (diff: readonly EditLine[]) => ({
  added: diff.filter((line) => line.kind === "add").length,
  removed: diff.filter((line) => line.kind === "del").length,
})

/** Splits `mcp__<server>__<tool>` (Claude) and `<server>.<tool>` (Codex); built-ins have no server. */
function splitName(name: string): { server: string | null; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp !== null) return { server: mcp[1]!, tool: mcp[2]! }
  const dot = name.indexOf(".")
  return dot > 0 ? { server: name.slice(0, dot), tool: name.slice(dot + 1) } : { server: null, tool: name }
}

const quote = (text: string, max = 60): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return `“${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}”`
}

function desktopView(tool: string, input: Readonly<Record<string, unknown>>, taskId: string): ToolView | null {
  const at = (x: unknown, y: unknown) => `(${num(x) ?? "?"}, ${num(y) ?? "?"})`
  const label = ((): string | null => {
    switch (tool) {
      case "desktop_open":
        return "Started the desktop"
      case "desktop_screenshot": {
        const region = record(input.region)
        if (num(region.width) !== undefined) {
          return `Took a screenshot of ${num(region.width)}×${num(region.height) ?? "?"} at ${at(region.x, region.y)}`
        }
        return input.changes === true ? "Checked the desktop for changes" : "Took a screenshot"
      }
      case "desktop_cursor_position":
        return "Read the mouse position"
      case "desktop_mouse_move":
        return `Moved the mouse to ${at(input.x, input.y)}`
      case "desktop_click": {
        const button = str(input.button)
        const verb = input.double === true ? "Double-clicked" : button === "right" ? "Right-clicked" : button === "middle" ? "Middle-clicked" : "Clicked"
        return `${verb} ${at(input.x, input.y)}`
      }
      case "desktop_drag":
        return `Dragged ${at(input.fromX, input.fromY)} → ${at(input.toX, input.toY)}`
      case "desktop_scroll": {
        const amount = num(input.amount)
        return `Scrolled ${str(input.direction) ?? ""}${amount !== undefined && amount !== 1 ? ` ×${amount}` : ""} at ${at(input.x, input.y)}`
      }
      case "desktop_type":
        return `Typed ${quote(str(input.text) ?? "")}`
      case "desktop_key": {
        const repeat = num(input.repeat)
        return `Pressed ${str(input.key) ?? "a key"}${repeat !== undefined && repeat > 1 ? ` ×${repeat}` : ""}`
      }
      case "desktop_launch":
        return `Launched ${commandPaths(displayCommand(str(input.command) ?? ""), taskId)}`
      case "desktop_processes":
        return "Listed desktop apps"
      case "desktop_kill":
        return `Stopped ${str(input.id) ?? "an app"}`
      default:
        return null
    }
  })()
  if (label === null) return null
  const icon: ToolIcon | undefined =
    tool === "desktop_screenshot"
      ? "camera"
      : tool === "desktop_type" || tool === "desktop_key"
        ? "keyboard"
        : ["desktop_click", "desktop_drag", "desktop_scroll", "desktop_mouse_move"].includes(tool)
          ? "pointer"
          : undefined
  return { kind: "desktop", icon, label, code: false, paths: [] }
}

function kestrelView(tool: string, input: Readonly<Record<string, unknown>>, taskId: string): ToolView | null {
  if (tool.startsWith("desktop_")) return desktopView(tool, input, taskId)
  switch (tool) {
    case "workspace_exec":
      return commandView(str(input.command) ?? "", taskId)
    case "repo_checkout": {
      const pr = num(input.pullRequest)
      return { kind: "other", icon: "git", label: `Checked out ${str(input.repo) ?? "a repository"}${pr !== undefined ? ` #${pr}` : ""}`, code: false, paths: [] }
    }
    case "task_report":
      return { kind: "other", icon: "message", label: `Reported ${str(input.status) ?? "progress"}`, code: false, paths: [], note: str(input.message) }
    case "task_ask":
      return { kind: "other", icon: "message", label: `Asked ${quote(str(input.question) ?? "")}`, code: false, paths: [] }
    case "evidence_record_start": {
      const caption = str(input.caption)
      return { kind: "desktop", icon: "camera", label: caption === undefined ? "Started recording" : `Started recording ${quote(caption)}`, code: false, paths: [] }
    }
    case "evidence_record_stop":
      return { kind: "desktop", icon: "camera", label: "Saved the desktop recording", code: false, paths: [] }
    case "evidence_attach_to_pr": {
      const caption = str(input.caption)
      const kind = input.poster === true ? "poster" : "clip"
      return {
        kind: "other",
        icon: "git",
        label: caption === undefined ? `Attached ${kind} to the pull request` : `Attached ${kind} to the pull request: ${quote(caption)}`,
        code: false,
        paths: [],
      }
    }
    default:
      return null
  }
}

function commandView(raw: string, taskId: string): ToolView {
  const command = commandPaths(displayCommand(raw), taskId)
  return { kind: "command", label: command.split("\n", 1)[0] ?? "", code: true, command, rawCommand: raw, paths: [] }
}

/** How one tool call reads in the transcript. Unknown tools fall back to their humanized name. */
export function describeTool(item: ToolItem, taskId: string): ToolView {
  const input = record(item.input)
  const { server, tool } = splitName(item.name)
  const path = (key: string) => {
    const value = str(input[key])
    return value === undefined ? undefined : displayToolPath(value, taskId)
  }

  if (server === "cloudagents") {
    const view = kestrelView(tool, input, taskId)
    if (view !== null) return view
  }
  if (server === null) {
    switch (tool) {
      case "Bash":
      case "command_execution":
        return commandView(str(input.command) ?? "", taskId)
      case "Read": {
        const file = path("file_path") ?? "a file"
        const offset = num(input.offset)
        const limit = num(input.limit)
        const range = offset !== undefined ? ` (lines ${offset}–${limit !== undefined ? offset + limit - 1 : "end"})` : ""
        return { kind: "read", label: `Read ${file}${range}`, code: false, paths: [] }
      }
      case "Write": {
        const file = path("file_path")
        const diff = editDiff("", str(input.content) ?? "")
        return { kind: "edit", label: `Wrote ${file ?? "a file"}`, code: false, paths: file ? [file] : [], diff, ...counts(diff) }
      }
      case "Edit":
      case "MultiEdit": {
        const file = path("file_path")
        const edits = tool === "Edit" ? [input] : (Array.isArray(input.edits) ? input.edits : []).map(record)
        const diff = edits.flatMap((edit, index) => [
          ...(index > 0 ? [{ kind: "context" as const, text: "⋯" }] : []),
          ...editDiff(str(edit.old_string) ?? "", str(edit.new_string) ?? ""),
        ])
        return { kind: "edit", label: `Edited ${file ?? "a file"}`, code: false, paths: file ? [file] : [], diff, ...counts(diff) }
      }
      case "file_change": {
        const changes = (Array.isArray(input.changes) ? input.changes : []).map(record).map((change) => ({
          path: displayToolPath(str(change.path) ?? "?", taskId),
          kind: str(change.kind) ?? "update",
        }))
        const verb = (kind: string) => (kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited")
        const label = changes.length === 1 ? `${verb(changes[0]!.kind)} ${changes[0]!.path}` : `Changed ${plural(changes.length, "file")}`
        return { kind: "edit", label, code: false, paths: changes.map((change) => change.path), changes }
      }
      case "Grep": {
        const where = path("path")
        const glob = str(input.glob)
        const scope = [where !== undefined && where !== "." ? `in ${where}` : "", glob ? `(${glob})` : ""].filter(Boolean).join(" ")
        return { kind: "search", label: `Searched for ${quote(str(input.pattern) ?? "")}${scope ? ` ${scope}` : ""}`, code: false, paths: [] }
      }
      case "Glob": {
        const where = path("path")
        return { kind: "search", label: `Found files matching ${str(input.pattern) ?? "?"}${where !== undefined && where !== "." ? ` in ${where}` : ""}`, code: false, paths: [] }
      }
      case "WebSearch":
      case "web_search":
        return { kind: "web", label: `Searched the web for ${quote(str(input.query) ?? "")}`, code: false, paths: [] }
      case "WebFetch": {
        const url = str(input.url) ?? ""
        return { kind: "web", label: `Fetched ${url.replace(/^https?:\/\/(www\.)?/, "")}`, code: false, paths: [] }
      }
      case "Task":
      case "Agent":
        return { kind: "agent", label: `Subagent: ${str(input.description) ?? str(input.subagent_type) ?? "task"}`, code: false, paths: [], note: str(input.prompt) }
      case "TodoWrite": {
        const todos = (Array.isArray(input.todos) ? input.todos : []).map(record).map((todo) => ({
          text: str(todo.content) ?? str(todo.activeForm) ?? "",
          status: str(todo.status) ?? "pending",
        }))
        const done = todos.filter((todo) => todo.status === "completed").length
        return { kind: "plan", label: `Updated the plan (${done}/${todos.length} done)`, code: false, paths: [], todos }
      }
    }
  }
  return { kind: "other", label: toolDisplayName(item.name), code: false, paths: [] }
}

const PHRASES: Record<ToolKind, (count: number) => string> = {
  command: (n) => `ran ${plural(n, "command")}`,
  read: (n) => `read ${plural(n, "file")}`,
  edit: (n) => `edited ${plural(n, "file")}`,
  search: (n) => (n === 1 ? "ran 1 search" : `ran ${n} searches`),
  web: (n) => `${plural(n, "web lookup")}`,
  desktop: (n) => `${plural(n, "desktop action")}`,
  agent: (n) => `ran ${plural(n, "subagent")}`,
  plan: (n) => (n === 1 ? "updated the plan" : `updated the plan ${n} times`),
  other: (n) => `${plural(n, "other tool call")}`,
}

/** "Ran 3 commands, read 2 files, +1 more": kinds in order of first use; edits count distinct files. */
export function summarizeTools(views: readonly ToolView[]): string {
  const byKind = new Map<ToolKind, ToolView[]>()
  for (const view of views) byKind.set(view.kind, [...(byKind.get(view.kind) ?? []), view])
  const phrases = [...byKind].map(([kind, list]) => {
    // An edit with no known path still counts as one file.
    const count = kind === "edit" ? new Set(list.flatMap<string | ToolView>((view) => (view.paths.length > 0 ? view.paths : [view]))).size : list.length
    return PHRASES[kind](count)
  })
  const shown = phrases.length > 4 ? [...phrases.slice(0, 3), `+${phrases.length - 3} more`] : phrases
  const text = shown.join(", ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * A tool's output as the details show it. Only Kestrel's desktop tools return images, which the transcript keeps as
 * an `[image]` line each; for them those lines become a count. Every other output is returned byte for byte.
 */
export function outputText(output: string | null, kind: ToolKind): { text: string; images: number } {
  if (output === null) return { text: "", images: 0 }
  if (kind !== "desktop") return { text: output, images: 0 }
  const kept = output.split("\n").filter((line) => line !== "[image]")
  return { text: kept.join("\n"), images: output.split("\n").length - kept.length }
}

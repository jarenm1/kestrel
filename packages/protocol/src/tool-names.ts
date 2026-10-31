const KESTREL_TOOLS: Readonly<Record<string, string>> = {
  desktop_open: "Start desktop",
  desktop_screenshot: "Take desktop screenshot",
  desktop_cursor_position: "Get mouse position",
  desktop_mouse_move: "Move mouse",
  desktop_click: "Click desktop",
  desktop_drag: "Drag on desktop",
  desktop_scroll: "Scroll desktop",
  desktop_type: "Type on desktop",
  desktop_key: "Press keyboard shortcut",
  desktop_launch: "Launch desktop app",
  desktop_processes: "List desktop apps",
  desktop_kill: "Stop desktop app",
  repo_checkout: "Check out repository",
  workspace_exec: "Run workspace command",
  toolkit_install: "Install desktop app",
  preview_open: "Open app preview",
  task_report: "Report progress",
  task_ask: "Ask you a question",
  task_inbox: "Read incoming messages",
  thread_list: "List other threads",
  thread_read: "Read thread messages",
  thread_send: "Message another agent",
  automation_list: "List automations",
  automation_create: "Create automation",
  automation_update: "Update automation",
  automation_delete: "Delete automation",
  git_push: "Push branch to GitHub",
  github_pr_create: "Open GitHub pull request",
  github_pr_status: "Check GitHub pull request",
  github_pr_review: "Review GitHub pull request",
}

const BUILTIN_TOOLS: Readonly<Record<string, string>> = {
  Bash: "Run shell command",
  command_execution: "Run shell command",
  Read: "Read file",
  Write: "Write file",
  Edit: "Edit file",
  MultiEdit: "Edit files",
  file_change: "Edit files",
  Glob: "Find files",
  Grep: "Search file contents",
  ToolSearch: "Find available tools",
  WebSearch: "Search the web",
  web_search: "Search the web",
  WebFetch: "Read web page",
  Task: "Run subagent",
  Agent: "Run subagent",
  TaskOutput: "Read background task output",
  TaskStop: "Stop background task",
  TodoWrite: "Update task plan",
  todo_list: "Update task plan",
  context_compaction: "Compact conversation",
  AskUserQuestion: "Ask you a question",
  EnterPlanMode: "Start planning",
  ExitPlanMode: "Finish planning",
  NotebookEdit: "Edit notebook",
  Skill: "Use skill",
}

function humanize(name: string): string {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_\s.\-]+/g, " ")
    .trim()
  return words === "" ? "Tool call" : words[0]!.toUpperCase() + words.slice(1)
}

function label(names: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(names, name) ? names[name] : undefined
}

/** Presentation only: keep the original tool identifier in stored items and expanded details. */
export function toolDisplayName(name: string): string {
  // Claude uses mcp__<server>__<tool>; Codex uses <server>.<tool>.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const dot = name.indexOf(".")
  const server = mcp?.[1] ?? (dot > 0 ? name.slice(0, dot) : null)
  const tool = mcp?.[2] ?? (dot > 0 ? name.slice(dot + 1) : name)

  if (server === "cloudagents") return label(KESTREL_TOOLS, tool) ?? humanize(tool)
  // External tools retain their server identity and never inherit a built-in tool's meaning.
  if (server !== null) return `${humanize(tool)} · ${humanize(server)}`
  return label(BUILTIN_TOOLS, tool) ?? label(KESTREL_TOOLS, tool) ?? humanize(tool)
}

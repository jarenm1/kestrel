import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { type Installed, NIX_PACKAGE, TOOLKITS, TOOLKIT_NAMES, type ToolkitName } from "../../sandbox/toolkits"
import { type RunContext, guard, runTool, text } from "./common"

type InstalledOnPath = Installed & { readonly shadowed: ReadonlyArray<string> }

export interface ToolkitToolDeps {
  /** Null when the box has no flake to build toolkits from; the tool is not offered then. */
  readonly toolkits: {
    readonly install: (taskId: string, name: ToolkitName) => Effect.Effect<InstalledOnPath, unknown>
    readonly installPackage: (taskId: string, attr: string) => Effect.Effect<InstalledOnPath, unknown>
  } | null
}

/** What an install put on PATH, and what it did not: links it took over and commands the sandbox's own copy shadows. */
export const describeInstall = (what: string, installed: InstalledOnPath): string =>
  [
    installed.exes.length === 0
      ? `installed ${what}; it has no executables. Its files are under ~/${installed.dir}/ (e.g. for PYTHONPATH).`
      : `installed ${what}; on PATH: ${installed.exes.join(", ")}. Its files are under ~/${installed.dir}/.`,
    ...(installed.replaced.length === 0 ? [] : [`replaced another install's command: ${installed.replaced.join(", ")}`]),
    ...(installed.shadowed.length === 0
      ? []
      : [
          `not used by plain name, since the sandbox already has its own: ${installed.shadowed.join(", ")}; ` +
            `run ~/.kestrel/bin/<name> for the installed one`,
        ]),
  ].join("\n")

/** ~/.kestrel/bin is the last PATH entry, and installs share it. */
const PATH_NOTE =
  "~/.kestrel/bin is last on PATH, so a command the sandbox already has (node, git, curl, rg, ...) keeps running the " +
  "sandbox's copy; the result names any such command. An install whose command has the same name as another install's " +
  "replaces that link, and the result says so."

export const registerToolkitTools = (server: McpServer, ctx: RunContext, deps: ToolkitToolDeps): void => {
  const toolkits = deps.toolkits
  if (toolkits === null) return
  server.registerTool(
    "toolkit_install",
    {
      description:
        "Install an optional desktop app into this task; install one only when the work needs it. The first install on " +
        "the box downloads it, which can take several minutes; later installs are quick. Its commands land on PATH for " +
        "every command started afterwards (workspace_exec, desktop_launch, the desktop terminal, and your own shell, whose " +
        "PATH already includes ~/.kestrel/bin). Start GUI apps with desktop_launch after desktop_open. Rendering is " +
        "software-only (no GPU), so prefer headless modes for heavy work. Toolkits:\n" +
        Object.entries(TOOLKITS)
          .map(([name, about]) => `- ${name}: ${about}`)
          .join("\n"),
      inputSchema: { name: z.enum(TOOLKIT_NAMES).describe("Toolkit to install.") },
    },
    ({ name }) =>
      guard(() => runTool(Effect.map(toolkits.install(ctx.taskId, name), (installed) => text(describeInstall(name, installed))))),
  )
  server.registerTool(
    "nix_install",
    {
      description:
        "Install a command-line package from nixpkgs into this task, by attribute path (e.g. 'ffmpeg', 'jq', " +
        "'imagemagick'). There is no `nix` command in your sandbox; this is how to get Nix packages. Its executables land " +
        "on PATH like a toolkit's (see toolkit_install). A library (e.g. 'python3Packages.requests') has no executables; " +
        "its files are under ~/.kestrel/toolkits/nixpkgs.<attr>/, e.g. for PYTHONPATH. " +
        PATH_NOTE +
        " Packages come from the nixpkgs the box pins, and only ones the public binary cache already has: one that would " +
        "have to be built from source fails with \"Unable to start any build\". Unfree packages are not available. GUI " +
        "apps get no fonts or GL setup here; use a toolkit for those. Installing again replaces the previous install " +
        "only once the new one is ready.",
      inputSchema: {
        attr: z.string().regex(NIX_PACKAGE).describe("nixpkgs attribute path, without `nixpkgs#`"),
      },
    },
    ({ attr }) =>
      guard(() =>
        runTool(Effect.map(toolkits.installPackage(ctx.taskId, attr), (installed) => text(describeInstall(attr, installed)))),
      ),
  )
}

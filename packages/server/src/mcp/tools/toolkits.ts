import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { NIX_PACKAGE, TOOLKITS, TOOLKIT_NAMES, type ToolkitName } from "../../sandbox/toolkits"
import { type RunContext, guard, runTool, text } from "./common"

export interface ToolkitToolDeps {
  /** Null when the box has no flake to build toolkits from; the tool is not offered then. */
  readonly toolkits: {
    readonly install: (taskId: string, name: ToolkitName) => Effect.Effect<ReadonlyArray<string>, unknown>
    readonly installPackage: (taskId: string, attr: string) => Effect.Effect<ReadonlyArray<string>, unknown>
  } | null
}

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
      guard(() =>
        runTool(Effect.map(toolkits.install(ctx.taskId, name), (exes) => text(`installed ${name}; on PATH: ${exes.join(", ")}`))),
      ),
  )
  server.registerTool(
    "nix_install",
    {
      description:
        "Install a command-line package from nixpkgs into this task, by attribute path (e.g. 'ffmpeg', 'imagemagick', " +
        "'python3Packages.requests'). There is no `nix` command in your sandbox; this is how to get Nix packages. Its " +
        "executables land on PATH like a toolkit's (see toolkit_install). Packages come from the nixpkgs the box pins, and " +
        "only ones the public binary cache already has: one that would have to be built from source fails with \"Unable " +
        "to start any build\". Unfree packages are not available. GUI apps get no fonts or GL setup here; use a toolkit " +
        "for those.",
      inputSchema: {
        attr: z.string().regex(NIX_PACKAGE).describe("nixpkgs attribute path, without `nixpkgs#`"),
      },
    },
    ({ attr }) =>
      guard(() =>
        runTool(
          Effect.map(toolkits.installPackage(ctx.taskId, attr), (exes) =>
            text(exes.length === 0 ? `installed ${attr}; it has no executables` : `installed ${attr}; on PATH: ${exes.join(", ")}`),
          ),
        ),
      ),
  )
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { TOOLKITS, TOOLKIT_NAMES, type ToolkitName } from "../../sandbox/toolkits"
import { type RunContext, guard, runTool, text } from "./common"

export interface ToolkitToolDeps {
  readonly toolkits: {
    readonly install: (taskId: string, name: ToolkitName) => Effect.Effect<ReadonlyArray<string>, unknown>
  }
}

export const registerToolkitTools = (server: McpServer, ctx: RunContext, deps: ToolkitToolDeps): void => {
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
        runTool(Effect.map(deps.toolkits.install(ctx.taskId, name), (exes) => text(`installed ${name}; on PATH: ${exes.join(", ")}`))),
      ),
  )
}

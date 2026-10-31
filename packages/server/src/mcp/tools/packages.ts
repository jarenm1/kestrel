import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import { z } from "zod"
import { MAX_PACKAGES, type PackageManager } from "../../sandbox/packages"
import { type RunContext, guard, runTool, text } from "./common"

export interface PackageToolDeps {
  /** Null when the box operator turned package installs off; the tool is not offered then. */
  readonly packages: {
    readonly manager: PackageManager
    readonly install: (taskId: string, names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string> | null, unknown>
  } | null
}

const ABOUT: Record<PackageManager, { readonly what: string; readonly names: string }> = {
  nix: {
    what:
      "Install packages from nixpkgs into this task. The box builds them outside the sandbox (the first install of a " +
      "package on the box downloads it, which can take minutes) and puts their commands on PATH for every command " +
      "started afterwards (workspace_exec, desktop_launch, the desktop terminal, and your own shell, whose PATH already " +
      "includes ~/.kestrel/bin).",
    names: "nixpkgs attribute names, e.g. ripgrep, ffmpeg, python3Packages.numpy",
  },
  apt: {
    what:
      "Install Debian/Ubuntu packages on this box with apt-get. They are installed system-wide and stay after this " +
      "task, so every thread on the box gets them; their commands land in /usr/bin, on PATH for every command started " +
      "afterwards.",
    names: "apt package names, e.g. ripgrep, ffmpeg, python3-numpy",
  },
}

export const registerPackageTools = (server: McpServer, ctx: RunContext, deps: PackageToolDeps): void => {
  const packages = deps.packages
  if (packages === null) return
  const about = ABOUT[packages.manager]
  server.registerTool(
    "package_install",
    {
      description:
        `${about.what} Install only what the work needs. Project dependencies belong to the project's own tools ` +
        "(npm, uv, cargo, ...), which already work in the workspace without this.",
      inputSchema: {
        names: z.array(z.string()).min(1).max(MAX_PACKAGES).describe(`Packages to install: ${about.names}.`),
      },
    },
    ({ names }) =>
      guard(() =>
        runTool(
          Effect.map(packages.install(ctx.taskId, names), (exes) =>
            text(
              exes === null
                ? `installed ${names.join(", ")} with apt`
                : `installed ${names.join(", ")}; on PATH: ${exes.length === 0 ? "(no commands)" : exes.join(", ")}`,
            ),
          ),
        ),
      ),
  )
}

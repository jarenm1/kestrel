import { Effect } from "effect"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { InternalError } from "@cloudagents/protocol"
import { TOOLKIT_BIN, findExecutable, runProcess } from "./index"

/**
 * Heavy desktop apps a task opts into. Each is the flake's `toolkit-<name>` package (flake.nix): built on the
 * host with `nix build` the first time any task installs it, then shared through the read-only /nix/store.
 */
export const TOOLKITS = {
  blender: "Blender (3D modelling, rendering, Python scripting). `blender` opens the GUI; `blender -b file.blend -P script.py` runs headless.",
  "roblox-studio":
    "Roblox Studio through Vinegar (Wine), plus Rojo and Wally. `vinegar run` downloads Studio on first use and opens it. Studio needs the user signed in to Roblox: its \"Login via Browser\" opens Firefox on the desktop, where the user signs in to roblox.com (Quick Login with a code approved from a device already signed in avoids typing a password here), then lets Firefox open the returned link with Vinegar. Ask the user (task_ask) to do this on the desktop; never handle their credentials yourself. Rojo syncs workspace files into Studio once its Studio plugin is installed.",
} as const

export type ToolkitName = keyof typeof TOOLKITS

export const TOOLKIT_NAMES = Object.keys(TOOLKITS) as [ToolkitName, ...ToolkitName[]]

/** Under the task home: one nix out-link per installed toolkit, also its GC root while the task exists. */
const TOOLKIT_LINKS = ".kestrel/toolkits"

/** First installs download hundreds of megabytes (Blender, Wine). */
const BUILD_TIMEOUT_MS = 30 * 60_000

const hostEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

/**
 * Builds the toolkit into the task home and links its executables into the home's toolkit bin dir, which every
 * launch has on PATH. Installing again rebuilds from the box's current flake. Returns the executable names.
 */
export const installToolkit = (
  flake: string | null,
  homeDir: string,
  name: ToolkitName,
): Effect.Effect<ReadonlyArray<string>, InternalError> =>
  Effect.gen(function* () {
    if (flake === null) {
      return yield* Effect.fail(
        new InternalError({ message: "toolkits need a box started through Nix (`nix run .#box` or `nix develop`): CLOUDAGENTS_TOOLKITS_FLAKE is not set" }),
      )
    }
    const nix = findExecutable("nix")
    if (nix === null) return yield* Effect.fail(new InternalError({ message: "nix not found on the box's PATH" }))
    const link = join(homeDir, TOOLKIT_LINKS, name)
    const binDir = join(homeDir, TOOLKIT_BIN)
    yield* Effect.tryPromise({
      try: () => Promise.all([mkdir(join(homeDir, TOOLKIT_LINKS), { recursive: true }), mkdir(binDir, { recursive: true })]),
      catch: (e) => new InternalError({ message: `cannot prepare toolkit dirs: ${String(e)}` }),
    })
    const build = yield* runProcess(nix, ["build", "--out-link", link, `${flake}#toolkit-${name}`], {
      cwd: homeDir,
      env: hostEnv(),
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    if (build.exitCode !== 0) {
      const why = build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`
      return yield* Effect.fail(new InternalError({ message: `building toolkit ${name} ${why}: ${build.stderr.tail.trim()}` }))
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const exes = await readdir(join(link, "bin"))
        for (const exe of exes) {
          const at = join(binDir, exe)
          await rm(at, { force: true })
          // Relative, so the link resolves both at /home/agent in the sandbox and at the host path.
          await symlink(join("..", "toolkits", name, "bin", exe), at)
        }
        return exes
      },
      catch: (e) => new InternalError({ message: `cannot link toolkit ${name}: ${String(e)}` }),
    })
  })

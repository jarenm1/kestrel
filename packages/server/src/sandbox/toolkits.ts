import { Effect } from "effect"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { InternalError } from "@cloudagents/protocol"
import { type CapturedOutput, TOOLKIT_BIN, findExecutable, runProcess } from "./index"

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

/** Under the task home: one dir of nix out-links per installed toolkit, their GC roots while the task exists. */
const TOOLKIT_LINKS = ".kestrel/toolkits"

/** First installs download hundreds of megabytes (Blender, Wine). */
const BUILD_TIMEOUT_MS = 30 * 60_000

const hostEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

/** The end of a failed command's output, for its error message. Short output is all in `head`. */
const outputEnd = (output: CapturedOutput): string =>
  (output.omittedBytes === 0 && output.tail === "" ? output.head : output.tail).trim().slice(-2000)

/**
 * Builds the toolkit from the box's flake (`CLOUDAGENTS_TOOLKITS_FLAKE`) with `nix build` on the host, outside the
 * sandbox, and links the executables of every output it built into the home's toolkit bin dir, which every launch has
 * on PATH. The out-links stay in `.kestrel/toolkits/<name>/` (`out`, or `out-bin`, `out-man`, ... for a multi-output
 * package); installing again rebuilds from the box's current flake and replaces them. Returns the executable names.
 */
export const installToolkit = (
  flake: string,
  homeDir: string,
  name: ToolkitName,
): Effect.Effect<ReadonlyArray<string>, InternalError> =>
  Effect.gen(function* () {
    const nix = findExecutable("nix")
    if (nix === null) return yield* Effect.fail(new InternalError({ message: "nix not found on the box's PATH" }))
    const dir = join(homeDir, TOOLKIT_LINKS, name)
    const binDir = join(homeDir, TOOLKIT_BIN)
    yield* Effect.tryPromise({
      try: async () => {
        // Also drops the single out-link an older box left at `dir` itself.
        await rm(dir, { recursive: true, force: true })
        await Promise.all([mkdir(dir, { recursive: true }), mkdir(binDir, { recursive: true })])
      },
      catch: (e) => new InternalError({ message: `cannot prepare toolkit dirs: ${String(e)}` }),
    })
    const build = yield* runProcess(nix, ["build", "--out-link", join(dir, "out"), `${flake}#toolkit-${name}`], {
      cwd: homeDir,
      env: hostEnv(),
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    if (build.exitCode !== 0) {
      const why = build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`
      return yield* Effect.fail(new InternalError({ message: `building toolkit ${name} ${why}: ${outputEnd(build.stderr)}` }))
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const exes: string[] = []
        for (const output of await readdir(dir)) {
          // Outputs without executables (`man`, `dev`, ...) have no bin dir.
          const bin = await readdir(join(dir, output, "bin")).catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT" || e.code === "ENOTDIR") return []
            throw e
          })
          for (const exe of bin) {
            const at = join(binDir, exe)
            await rm(at, { force: true })
            // Relative, so the link resolves both at /home/agent in the sandbox and at the host path.
            await symlink(join("..", "toolkits", name, output, "bin", exe), at)
            exes.push(exe)
          }
        }
        return exes
      },
      catch: (e) => new InternalError({ message: `cannot link toolkit ${name}: ${String(e)}` }),
    })
  })

import { Effect } from "effect"
import { mkdir, readdir, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { InternalError } from "@cloudagents/protocol"
import { type CapturedOutput, TOOLKIT_BIN, findExecutable, runProcess } from "./index"

/** First installs can download hundreds of megabytes (Blender, Wine). */
const BUILD_TIMEOUT_MS = 30 * 60_000

export const hostEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

/** The end of a failed command's output, for its error message. Short output is all in `head`. */
export const outputEnd = (output: CapturedOutput): string =>
  (output.omittedBytes === 0 && output.tail === "" ? output.head : output.tail).trim().slice(-2000)

/**
 * Builds `installable` with `nix build` on the host, outside the sandbox, and links the executables of every output it
 * built into the task home's `.kestrel/bin`, which every launch has on PATH. The out-links stay under the task home at
 * `.kestrel/<group>/<name>/` (`out`, or `out-bin`, `out-man`, ... for a multi-output package), the GC roots of the
 * build while the task exists; installing again replaces them. The sandbox sees the result read-only through
 * /nix/store. Returns the executable names.
 */
export const nixInstall = (
  homeDir: string,
  group: "toolkits" | "packages",
  name: string,
  installable: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InternalError> =>
  Effect.gen(function* () {
    const what = `${group === "toolkits" ? "toolkit" : "package"} ${name}`
    const nix = findExecutable("nix")
    if (nix === null) return yield* Effect.fail(new InternalError({ message: "nix not found on the box's PATH" }))
    const dir = join(homeDir, ".kestrel", group, name)
    const binDir = join(homeDir, TOOLKIT_BIN)
    yield* Effect.tryPromise({
      try: async () => {
        // Also drops an out-link left at `dir` itself by an older box.
        await rm(dir, { recursive: true, force: true })
        await Promise.all([mkdir(dir, { recursive: true }), mkdir(binDir, { recursive: true })])
      },
      catch: (e) => new InternalError({ message: `cannot prepare dirs for ${what}: ${String(e)}` }),
    })
    const build = yield* runProcess(nix, ["build", "--out-link", join(dir, "out"), ...installable], {
      cwd: homeDir,
      env: hostEnv(),
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    if (build.exitCode !== 0) {
      const why = build.timedOut ? "timed out" : `failed (exit ${build.exitCode})`
      return yield* Effect.fail(new InternalError({ message: `building ${what} ${why}: ${outputEnd(build.stderr)}` }))
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
            await symlink(join("..", group, name, output, "bin", exe), at)
            exes.push(exe)
          }
        }
        return exes
      },
      catch: (e) => new InternalError({ message: `cannot link ${what}: ${String(e)}` }),
    })
  })

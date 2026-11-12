import { Effect } from "effect"
import { existsSync } from "node:fs"
import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises"
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
export const TOOLKIT_LINKS = ".kestrel/toolkits"

/** First installs download hundreds of megabytes (Blender, Wine). */
const BUILD_TIMEOUT_MS = 30 * 60_000

/** Rooting paths that are already in the store does no download or build. */
const ROOT_TIMEOUT_MS = 60_000

const hostEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

/** The end of a failed command's output, for its error message. Short output is all in `head`. */
const outputEnd = (output: CapturedOutput): string =>
  (output.omittedBytes === 0 && output.tail === "" ? output.head : output.tail).trim().slice(-2000)

export interface Installed {
  /** Under the task home, the dir of out-links: the package's files, also for one with no executables. */
  readonly dir: string
  /** Executables linked into the home's toolkit bin dir. */
  readonly exes: ReadonlyArray<string>
  /** Links this install took over from another install, as `exe (previous owner)`. */
  readonly replaced: ReadonlyArray<string>
}

/**
 * Builds the toolkit from the box's flake (`CLOUDAGENTS_TOOLKITS_FLAKE`) with `nix build` on the host, outside the
 * sandbox, and links the executables of every output it built into the home's toolkit bin dir, which every launch has
 * on PATH. The out-links stay in `.kestrel/toolkits/<name>/`; installing again rebuilds from the box's current flake
 * and replaces them, and a failed install leaves the previous one as it was.
 */
export const installToolkit = (flake: string, homeDir: string, name: ToolkitName): Effect.Effect<Installed, InternalError> =>
  buildAndLink(homeDir, name, `toolkit ${name}`, [`${flake}#toolkit-${name}`])

/** A nixpkgs attribute path such as `ffmpeg` or `python3Packages.requests`; nothing that reads as another flake ref. */
export const NIX_PACKAGE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/

/**
 * Installs a nixpkgs package the way installToolkit installs a toolkit, from the nixpkgs the box's flake pins
 * (`--inputs-from`). `--max-jobs 0` allows no local builds, so only what the binary cache already has installs: an
 * agent cannot start an hours-long compile on the host. Out-links stay in `.kestrel/toolkits/nixpkgs.<attr>/`.
 */
export const installNixPackage = (flake: string, homeDir: string, attr: string): Effect.Effect<Installed, InternalError> =>
  NIX_PACKAGE.test(attr)
    ? buildAndLink(homeDir, `nixpkgs.${attr}`, `nixpkgs#${attr}`, ["--inputs-from", flake, "--max-jobs", "0", `nixpkgs#${attr}`])
    : Effect.fail(new InternalError({ message: `not a nixpkgs attribute path: ${attr}` }))

/**
 * Of `exes`, those the sandbox's own PATH (`pathEnv`, which comes before the toolkit bin dir) already provides: a
 * command there runs that copy, not the installed one.
 */
export const shadowedExes = (exes: ReadonlyArray<string>, pathEnv: string): ReadonlyArray<string> =>
  exes.filter((exe) => findExecutable(exe, pathEnv) !== null)

/** The install a toolkit bin link belongs to: `../toolkits/<name>/<output>/bin/<exe>`. */
const linkOwner = (target: string): string | null => target.match(/^\.\.\/toolkits\/([^/]+)\//)?.[1] ?? null

/**
 * Builds into `<name>.new` first, so a failed build (an attr a flake update left uncached, a network error) keeps the
 * installed version and its links. On success the outputs are rooted again at `<name>/` by store path. Moving the
 * out-links instead would strand them: nix records a GC root by the link's path. Links whose target is gone (an
 * executable the new version dropped) are removed from the bin dir.
 */
const buildAndLink = (
  homeDir: string,
  name: string,
  label: string,
  buildArgs: ReadonlyArray<string>,
): Effect.Effect<Installed, InternalError> =>
  Effect.gen(function* () {
    const nix = findExecutable("nix")
    if (nix === null) return yield* Effect.fail(new InternalError({ message: "nix not found on the box's PATH" }))
    const dir = join(homeDir, TOOLKIT_LINKS, name)
    const staging = `${dir}.new`
    const binDir = join(homeDir, TOOLKIT_BIN)
    const fsStep = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (e) => new InternalError({ message: `cannot ${what} for ${label}: ${String(e)}` }) })
    const nixStep = (args: ReadonlyArray<string>, timeoutMs: number) =>
      Effect.flatMap(runProcess(nix, ["build", ...args], { cwd: homeDir, env: hostEnv(), timeoutMs }), (result) => {
        if (result.exitCode === 0) return Effect.succeed(result)
        const why = result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`
        return Effect.fail(new InternalError({ message: `building ${label} ${why}: ${outputEnd(result.stderr)}` }))
      })

    yield* fsStep("prepare toolkit dirs", async () => {
      await rm(staging, { recursive: true, force: true })
      await Promise.all([mkdir(staging, { recursive: true }), mkdir(binDir, { recursive: true })])
    })
    const dropStaging = fsStep("remove staging", () => rm(staging, { recursive: true, force: true })).pipe(Effect.ignore)
    const built = yield* nixStep(["--print-out-paths", "--out-link", join(staging, "out"), ...buildArgs], BUILD_TIMEOUT_MS).pipe(
      Effect.tapError(() => dropStaging),
    )
    const paths = built.stdout.head.split("\n").filter((line) => line.startsWith("/"))
    // Also drops the single out-link an older box left at `dir` itself.
    yield* fsStep("replace toolkit dir", async () => {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
    })
    yield* nixStep(["--out-link", join(dir, "out"), ...paths], ROOT_TIMEOUT_MS).pipe(Effect.ensuring(dropStaging))

    return yield* fsStep("link executables", async () => {
      const exes: string[] = []
      const replaced: string[] = []
      for (const output of await readdir(dir)) {
        // Outputs without executables (`man`, `dev`, ...) have no bin dir.
        const bin = await readdir(join(dir, output, "bin")).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT" || e.code === "ENOTDIR") return []
          throw e
        })
        for (const exe of bin) {
          const at = join(binDir, exe)
          const previous = linkOwner(await readlink(at).catch(() => ""))
          if (previous !== null && previous !== name && existsSync(at)) replaced.push(`${exe} (${previous})`)
          await rm(at, { force: true })
          // Relative, so the link resolves both at /home/agent in the sandbox and at the host path.
          await symlink(join("..", "toolkits", name, output, "bin", exe), at)
          exes.push(exe)
        }
      }
      for (const entry of await readdir(binDir)) {
        const at = join(binDir, entry)
        if ((await lstat(at)).isSymbolicLink() && !existsSync(at)) await rm(at, { force: true })
      }
      return { dir: join(TOOLKIT_LINKS, name), exes, replaced }
    })
  })

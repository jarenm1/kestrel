import { Effect } from "effect"
import { BadRequest, InternalError } from "@cloudagents/protocol"
import { runProcess } from "./index"
import { hostEnv, nixInstall, outputEnd } from "./nix"

/**
 * The package manager behind the agent's `package_install` tool, chosen by the box operator (CLOUDAGENTS_PACKAGES):
 * - `nix`: `nix build` of nixpkgs on the host into the task home, per task, no root (see `nixInstall`).
 * - `apt`: `sudo -n apt-get install` on the host: system-wide and permanent, so only for a box one user owns.
 */
export type PackageManager = "nix" | "apt"

export const MAX_PACKAGES = 20

/** Names are passed as arguments after `--`, but never let one look like an option or a path. */
const PACKAGE_NAME: Record<PackageManager, RegExp> = {
  // A nixpkgs attribute path: `ripgrep`, `python3Packages.numpy`.
  nix: /^[A-Za-z0-9_][A-Za-z0-9_+-]*(\.[A-Za-z0-9_][A-Za-z0-9_+-]*)*$/,
  // Debian policy package names.
  apt: /^[a-z0-9][a-z0-9+.-]+$/,
}

const APT_TIMEOUT_MS = 30 * 60_000

/** Installs packages for a task; returns the executables it put on the task's PATH, or null when apt installed them system-wide. */
export interface PackageInstaller {
  readonly manager: PackageManager
  readonly install: (
    homeDir: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string> | null, BadRequest | InternalError>
}

export type PackageSettings =
  /** `flake`: the box's flake, whose locked nixpkgs input pins the packages; null resolves `nixpkgs` through the registry. */
  | { readonly manager: "nix"; readonly flake: string | null }
  /** Absolute paths of `sudo` and `apt-get`, resolved at startup. */
  | { readonly manager: "apt"; readonly sudo: string; readonly aptGet: string }

const checkNames = (manager: PackageManager, names: ReadonlyArray<string>): Effect.Effect<void, BadRequest> => {
  if (names.length === 0 || names.length > MAX_PACKAGES) {
    return Effect.fail(new BadRequest({ message: `give 1 to ${MAX_PACKAGES} package names` }))
  }
  const bad = names.filter((name) => !PACKAGE_NAME[manager].test(name))
  return bad.length === 0
    ? Effect.void
    : Effect.fail(new BadRequest({ message: `not ${manager === "nix" ? "nixpkgs attribute" : "apt package"} names: ${bad.join(", ")}` }))
}

export const makePackageInstaller = (settings: PackageSettings): Effect.Effect<PackageInstaller> =>
  Effect.gen(function* () {
    if (settings.manager === "nix") {
      const inputs = settings.flake === null ? [] : ["--inputs-from", settings.flake]
      return {
        manager: "nix",
        install: (homeDir, names) =>
          Effect.gen(function* () {
            yield* checkNames("nix", names)
            const exes = yield* Effect.forEach(names, (name) => nixInstall(homeDir, "packages", name, [...inputs, `nixpkgs#${name}`]))
            return exes.flat()
          }),
      } satisfies PackageInstaller
    }
    const { sudo, aptGet } = settings
    // dpkg holds a host-wide lock: one install at a time.
    const lock = yield* Effect.makeSemaphore(1)
    return {
      manager: "apt",
      install: (_homeDir, names) =>
        Effect.gen(function* () {
          yield* checkNames("apt", names)
          // -n: never prompt for a password. DEBIAN_FRONTEND keeps debconf from waiting for an answer (sudoers: SETENV).
          const result = yield* lock.withPermits(1)(
            runProcess(sudo, ["-n", "DEBIAN_FRONTEND=noninteractive", aptGet, "install", "-y", "--no-install-recommends", "--", ...names], {
              cwd: "/",
              env: hostEnv(),
              timeoutMs: APT_TIMEOUT_MS,
            }),
          )
          if (result.exitCode !== 0) {
            const why = result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`
            return yield* Effect.fail(new InternalError({ message: `apt-get install ${names.join(" ")} ${why}: ${outputEnd(result.stderr)}` }))
          }
          return null
        }),
    } satisfies PackageInstaller
  })

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { GH_SHIM_SCRIPT } from "../gh/shim"
import { SANDBOX_HOME, buildBwrapArgv } from "."

const base = { workspacePath: "/w", mirrorDir: "/m", homeDir: "/h", env: {}, command: "true" }

/** The real thing needs a toolchain inside the nix store, the only part of the host strict shows. */
const envPath = Bun.which("env")
const runnable = Bun.which("bwrap") !== null && envPath !== null && envPath.startsWith("/nix/store/")

describe("buildBwrapArgv", () => {
  test("strict links /usr/bin/env to the toolchain's env", () => {
    const argv = buildBwrapArgv({ ...base, level: "strict", binPath: "/nix/store/x-env/bin" })
    const at = argv.indexOf("--symlink")
    expect(argv.slice(at, at + 3)).toEqual(["--symlink", "/nix/store/x-env/bin/env", "/usr/bin/env"])
  })

  test("basic keeps the host's own /usr/bin/env", () => {
    expect(buildBwrapArgv({ ...base, level: "basic", binPath: "/nix/store/x-env/bin" })).not.toContain("/usr/bin/env")
  })

  test.skipIf(!runnable)("a strict sandbox runs the gh shim by its shebang", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-sandbox-"))
    try {
      const homeDir = join(root, "home")
      const workspacePath = join(root, "workspace")
      const mirrorDir = join(root, "mirror")
      const ghDir = join(homeDir, ".kestrel", "gh")
      for (const dir of [ghDir, workspacePath, mirrorDir]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(ghDir, "gh"), GH_SHIM_SCRIPT)
      chmodSync(join(ghDir, "gh"), 0o755)

      const binPath = dirname(envPath as string)
      const argv = buildBwrapArgv({
        level: "strict",
        binPath,
        workspacePath,
        mirrorDir,
        homeDir,
        env: { PATH: `${SANDBOX_HOME}/.kestrel/gh:${binPath}` },
        command: "gh --version",
      })
      const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" })

      // No KESTREL_GH_URL here: reaching this message means the script ran, instead of exit 126 from its shebang.
      expect(result.stderr).toContain("gh: only available inside a Kestrel agent run")
      expect(result.status).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

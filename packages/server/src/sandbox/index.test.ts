import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { GH_SHIM_SCRIPT } from "../gh/shim"
import { SANDBOX_HOME, buildBwrapArgv, cliBwrapArgs, homeToolArgs } from "."

const base = { workspacePath: "/w", cwd: "/w", mirrorDir: "/m", homeDir: "/h", env: {}, command: "true" }

/** The real thing needs a toolchain inside the nix store, the only part of the host strict shows. */
const envPath = Bun.which("env")
const bashPath = Bun.which("bash")
const shellDir = bashPath !== null && bashPath.startsWith("/nix/store/") ? dirname(bashPath) : null
const shPath = shellDir === null ? null : existsSync(join(shellDir, "sh")) ? join(shellDir, "sh") : null
const runnable =
  Bun.which("bwrap") !== null &&
  envPath !== null &&
  envPath.startsWith("/nix/store/") &&
  shellDir !== null &&
  shPath !== null

describe("buildBwrapArgv", () => {
  test("strict links /usr/bin/env to the toolchain's env", () => {
    const argv = buildBwrapArgv({ ...base, level: "strict", binPath: "/nix/store/x-env/bin" })
    const at = argv.indexOf("--symlink")
    expect(argv.slice(at, at + 3)).toEqual(["--symlink", "/nix/store/x-env/bin/env", "/usr/bin/env"])
  })

  test("basic keeps the host's own /usr/bin/env", () => {
    expect(buildBwrapArgv({ ...base, level: "basic", binPath: "/nix/store/x-env/bin" })).not.toContain("/usr/bin/env")
  })

  test("a desktop's audio socket is bound beside its X socket only when audio is on", () => {
    const withAudio = buildBwrapArgv({ ...base, level: "basic", display: 101, audio: true })
    const at = withAudio.indexOf("/tmp/.X11-unix/pulse-101")
    expect(withAudio.slice(at - 1, at + 2)).toEqual(["--bind", "/tmp/.X11-unix/pulse-101", "/tmp/.X11-unix/pulse-101"])
    expect(buildBwrapArgv({ ...base, level: "basic", display: 101 })).not.toContain("/tmp/.X11-unix/pulse-101")
    expect(buildBwrapArgv({ ...base, level: "basic", audio: true })).not.toContain("/tmp/.X11-unix/pulse-101")
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
        cwd: workspacePath,
        mirrorDir,
        homeDir,
        // bwrap runs `sh -c <command>`; the sandbox starts with the toolchain's PATH, which needs a shell too.
        env: { PATH: `${SANDBOX_HOME}/.kestrel/gh:${binPath}:${shellDir}` },
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

  test.skipIf(!runnable)("a strict sandbox runs scripts whose shebang names /bin/sh or /bin/bash", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-shebang-"))
    try {
      const homeDir = join(root, "home")
      const workspacePath = join(root, "workspace")
      const mirrorDir = join(root, "mirror")
      const binPath = join(root, "toolchain-bin")
      for (const dir of [homeDir, workspacePath, mirrorDir, binPath]) mkdirSync(dir, { recursive: true })
      // The toolchain dir is bound read-only so the symlinks' targets exist inside the sandbox too.
      for (const name of ["env", "sh", "bash"]) {
        const target = name === "sh" ? (shPath as string) : (Bun.which(name) as string)
        symlinkSync(target, join(binPath, name))
      }
      writeFileSync(join(workspacePath, "s-sh"), "#!/bin/sh\necho SH-OK\n")
      writeFileSync(join(workspacePath, "s-bash"), "#!/bin/bash\necho BASH-OK\n")
      writeFileSync(join(workspacePath, "s-env"), "#!/usr/bin/env bash\necho ENVBASH-OK\n")
      for (const name of ["s-sh", "s-bash", "s-env"]) chmodSync(join(workspacePath, name), 0o755)
      const argv = buildBwrapArgv({
        level: "strict",
        binPath,
        workspacePath,
        cwd: workspacePath,
        mirrorDir,
        homeDir,
        roBinds: [binPath],
        env: { PATH: binPath },
        command: "set -e\n./s-sh\n./s-bash\n./s-env",
      })
      const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" })
      expect(result.stdout).toContain("SH-OK")
      expect(result.stdout).toContain("BASH-OK")
      expect(result.stdout).toContain("ENVBASH-OK")
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("cliBwrapArgs", () => {
  // `basic` binds the host's system directories, so any Linux host with bwrap runs this.
  test.skipIf(Bun.which("bwrap") === null)("discovery started in a checkout replaced by a symlink sees nothing behind it", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-discovery-"))
    try {
      const home = join(root, "home")
      const workspace = join(root, "threads", "t1")
      const secret = join(root, "host-only")
      for (const dir of [home, join(workspace, "real"), secret]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(workspace, "real", "PROJECT_FILE"), "")
      writeFileSync(join(secret, "HOST_SECRET"), "")
      // What an agent can do in its read-write workspace: replace its checkout with a link to a host directory.
      symlinkSync(secret, join(workspace, "linked"))
      const ls = (cwd: string) => {
        const argv = cliBwrapArgs(home, {}, ["ls"], { level: "basic", homeToolArgs: [], network: "none", workspacePath: workspace, cwd })
        const result = spawnSync("bwrap", argv, { encoding: "utf8" })
        return result.stdout + result.stderr
      }
      expect(ls(join(workspace, "real"))).toContain("PROJECT_FILE")
      // The link resolves inside the sandbox, where the host directory is not mounted: no listing, no secret.
      expect(ls(join(workspace, "linked"))).not.toContain("HOST_SECRET")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test("an npm-installed Pi and its adapter are both bound from $HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-home-tools-"))
  try {
    const home = join(root, "home")
    const bin = join(home, ".npm-global", "bin")
    mkdirSync(bin, { recursive: true })
    const pi = join(bin, "pi")
    const adapter = join(bin, "pi-acp")
    writeFileSync(pi, "#!/bin/sh\nexit 0\n")
    writeFileSync(adapter, "#!/bin/sh\nexit 0\n")
    chmodSync(pi, 0o755)
    chmodSync(adapter, 0o755)
    const args = homeToolArgs(home, bin)
    // `basic` binds a CLI found in $HOME; the adapter starts `pi`, so both package entry points must be there.
    expect(args).toContain(pi)
    expect(args).toContain(adapter)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { GH_SHIM_SCRIPT } from "../gh/shim"
import {
  SANDBOX_HOME,
  SANDBOX_HOSTNAME,
  SANDBOX_USER,
  buildBwrapArgv,
  cliBwrapArgs,
  ensureIdentityFiles,
  identityFileContents,
  runProcess,
  writeFileCommand,
} from "."

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

  // `basic` binds the host's whole /etc, so this also checks the identity files land over it.
  test.skipIf(Bun.which("bwrap") === null)("the sandbox names the box user agent and shows none of the host's accounts or hostname", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-identity-"))
    try {
      const homeDir = join(root, "home")
      const workspacePath = join(root, "workspace")
      const mirrorDir = join(root, "mirror")
      for (const dir of [homeDir, workspacePath, mirrorDir]) mkdirSync(dir, { recursive: true })
      const identity = await Effect.runPromise(ensureIdentityFiles(join(root, "sandbox-etc")))
      const argv = buildBwrapArgv({
        level: "basic",
        workspacePath,
        cwd: workspacePath,
        mirrorDir,
        homeDir,
        identity,
        env: {},
        // Builtins only: the sandbox env is empty, so hosts without coreutils in the default PATH still run this.
        command: "while read -r line; do echo \"$line\"; done < /etc/passwd; read -r h < /proc/sys/kernel/hostname; echo \"HOST=$h\"",
      })
      const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`${SANDBOX_USER}:x:${process.getuid?.()}:${process.getgid?.()}::${SANDBOX_HOME}:/bin/bash`)
      expect(result.stdout).toContain(`HOST=${SANDBOX_HOSTNAME}`)
      expect(result.stdout).not.toContain(`HOST=${hostname()}\n`)
      const hostUser = userInfo().username
      if (hostUser !== SANDBOX_USER) expect(result.stdout).not.toContain(`${hostUser}:`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("identityFileContents", () => {
  test("lists root, the box user and nobody, with their groups", () => {
    const { passwd, group } = identityFileContents(1000, 100)
    expect(passwd).toBe(
      "root:x:0:0::/root:/bin/sh\nagent:x:1000:100::/home/agent:/bin/bash\nnobody:x:65534:65534::/var/empty:/bin/sh\n",
    )
    expect(group).toBe("root:x:0:\nagent:x:100:\nnogroup:x:65534:\n")
  })

  test("the box user's entry replaces one whose id it shares", () => {
    const { passwd, group } = identityFileContents(65534, 65534)
    expect(passwd).toBe("root:x:0:0::/root:/bin/sh\nagent:x:65534:65534::/home/agent:/bin/bash\n")
    expect(group).toBe("root:x:0:\nagent:x:65534:\n")
  })
})

describe("ensureIdentityFiles", () => {
  test("concurrent first launches share one write", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-identity-race-"))
    try {
      const dir = join(root, "sandbox-etc")
      const results = await Promise.all(Array.from({ length: 8 }, () => Effect.runPromise(ensureIdentityFiles(dir))))
      const expected = identityFileContents(process.getuid?.() ?? 0, process.getgid?.() ?? 0)
      for (const files of results) expect(files).toEqual(results[0] as (typeof results)[number])
      expect(readFileSync(join(dir, "passwd"), "utf8")).toBe(expected.passwd)
      expect(readFileSync(join(dir, "group"), "utf8")).toBe(expected.group)
      expect(readdirSync(dir).sort()).toEqual(["group", "passwd"])
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
      const list = (cwd: string) => {
        // Builtins only: the sandbox env is empty, so a host without coreutils on the default PATH still lists here.
        const argv = cliBwrapArgs(home, {}, ["sh", "-c", "for entry in *; do echo \"$entry\"; done"], { level: "basic", homeToolArgs: [], network: "none", workspacePath: workspace, cwd })
        const result = spawnSync("bwrap", argv, { encoding: "utf8" })
        return result.stdout + result.stderr
      }
      expect(list(join(workspace, "real"))).toContain("PROJECT_FILE")
      // The link resolves inside the sandbox, where the host directory is not mounted: no listing, no secret.
      expect(list(join(workspace, "linked"))).not.toContain("HOST_SECRET")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.skipIf(Bun.which("bwrap") === null)("a masked subtree is empty and writable inside the login home", () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-accounts-sandbox-"))
    try {
      const home = join(root, "user")
      const accounts = join(home, "accounts")
      mkdirSync(join(accounts, "other"), { recursive: true })
      writeFileSync(join(accounts, "other", "token"), "SECRET\n")
      writeFileSync(join(home, "own-login"), "")
      // Builtins only: the sandbox env is empty, so hosts without coreutils in the default PATH still run this.
      const inspect = "for entry in *; do echo \"$entry\"; done; test -w accounts; read secret < accounts/other/token 2>/dev/null && echo \"$secret\"; true"
      const run = (mask: ReadonlyArray<string>) =>
        spawnSync("bwrap", cliBwrapArgs(home, {}, ["sh", "-c", inspect], {
          level: "basic",
          homeToolArgs: [],
          network: "none",
          mask,
        }), { encoding: "utf8" })
      // Without the mask the default login's home exposes every other account's credentials.
      expect(run([]).stdout).toContain("SECRET")
      // With it the subtree exists, is writable, and holds none of the other logins.
      const masked = run([accounts])
      expect(masked.status).toBe(0)
      expect(masked.stdout).toContain("own-login")
      expect(masked.stdout).toContain("accounts")
      expect(`${masked.stdout}${masked.stderr}`).not.toContain("SECRET")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("writeFileCommand", () => {
  test.skipIf(Bun.which("bwrap") === null)("writes stdin from inside the sandbox and cannot follow a link out of it", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-write-"))
    try {
      const homeDir = join(root, "home")
      const workspacePath = join(root, "workspace")
      const mirrorDir = join(root, "mirror")
      const outside = join(root, "outside")
      for (const dir of [homeDir, workspacePath, mirrorDir, outside]) mkdirSync(dir, { recursive: true })
      // The host dir behind this link is not bound into the sandbox.
      symlinkSync(outside, join(workspacePath, "escape"))
      const write = (path: string, data: Uint8Array) => {
        const argv = buildBwrapArgv({
          level: "basic",
          workspacePath,
          cwd: workspacePath,
          mirrorDir,
          homeDir,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          command: writeFileCommand(workspacePath, path),
        })
        return Effect.runPromise(runProcess(Bun.which("bwrap") as string, argv.slice(1), { cwd: root, env: {}, stdin: data }))
      }

      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13])
      const name = `shots/it's a "$HOME" test.png`
      const written = await write(name, png)
      expect(written.exitCode).toBe(0)
      expect(written.stdout.head.trim()).toBe(join(workspacePath, name))
      expect(new Uint8Array(readFileSync(join(workspacePath, name)))).toEqual(png)

      // Overwriting replaces the file and leaves no temp file beside it.
      const next = new Uint8Array([1, 2, 3])
      expect((await write(name, next)).exitCode).toBe(0)
      expect(new Uint8Array(readFileSync(join(workspacePath, name)))).toEqual(next)
      expect(readdirSync(join(workspacePath, "shots"))).toEqual([`it's a "$HOME" test.png`])

      // Paths that resolve outside the workspace are refused: the sandbox's own /tmp would vanish with the launch.
      for (const path of ["/tmp/x.png", "../outside/x.png", "escape/x.png"]) {
        const refused = await write(path, png)
        expect(refused.exitCode).not.toBe(0)
        expect(refused.stderr.head).toContain("not inside the workspace")
      }
      expect(readdirSync(outside)).toEqual([])

      // A write that fails partway leaves the existing file as it was. The dir is read-only, the file still
      // writable, so writing in place would have truncated it.
      const locked = join(workspacePath, "locked")
      mkdirSync(locked)
      writeFileSync(join(locked, "before.png"), png)
      chmodSync(locked, 0o555)
      expect((await write("locked/before.png", next)).exitCode).not.toBe(0)
      expect(new Uint8Array(readFileSync(join(locked, "before.png")))).toEqual(png)
      expect(readdirSync(locked)).toEqual(["before.png"])
      chmodSync(locked, 0o755)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

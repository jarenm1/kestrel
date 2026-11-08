import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { CliAuthStatus } from "@cloudagents/protocol"
import type { ServerConfig } from "./config"
import { Config } from "./config"
import { CliAuth, CliAuthLive, CLI_PENDING_LOGIN_MARKER } from "./cliauth"
import { limitDiscovery } from "./harness-commands"
import { findExecutable } from "./sandbox"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const rootFor = (): string => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-cliauth-"))
  roots.push(root)
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  // The status check only needs to find the binary: Antigravity's is a file check, not a spawned command.
  if (process.platform !== "win32") {
    const agy = join(bin, "agy")
    writeFileSync(agy, "#!/bin/sh\nexit 0\n")
    chmodSync(agy, 0o755)
  }
  return root
}

const tokenPath = (root: string): string =>
  join(root, "users", "alice", "antigravity", "antigravity-cli", "antigravity-oauth-token")

const writeCredential = (root: string, credential: string): void => {
  const path = tokenPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, credential)
}

const statusesFor = async (root: string) => {
  const config = { dataDir: root, sandbox: "off", sandboxPath: join(root, "bin"), sandboxSslCertFile: null } as unknown as ServerConfig
  const layer = CliAuthLive.pipe(Layer.provide(Layer.succeed(Config, config)))
  return Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* CliAuth
      return yield* auth.status("alice")
    }).pipe(Effect.provide(layer)),
  )
}

const jwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-real-signature`

const antigravity = (statuses: ReadonlyArray<CliAuthStatus>) => {
  const status = statuses.find((row) => row.provider === "antigravity-cli")
  if (status === undefined) throw new Error("antigravity status is missing")
  return status
}

describe("OpenCode status", () => {
  test.skipIf(process.platform === "win32")("gives the Console and Go logins their own XDG_DATA_HOME", async () => {
    const root = rootFor()
    const opencode = join(root, "bin", "opencode")
    writeFileSync(
      opencode,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  case "$XDG_DATA_HOME" in',
        `    */opencode-go) echo "2.1.0" ;;`,
        `    *) echo "2.0.7" ;;`,
        "  esac",
        "  exit 0",
        "fi",
        'case "$XDG_DATA_HOME" in',
        `  */opencode-go) echo '[{"id":"opencode-go","connections":[{"id":"go"}]}]' ;;`,
        `  */opencode) echo '[{"id":"opencode","connections":[{"id":"free"}]}]' ;;`,
        `  *) echo '[]' ;;`,
        "esac",
        "",
      ].join("\n"),
    )
    chmodSync(opencode, 0o755)
    mkdirSync(join(root, "users", "alice", "opencode"), { recursive: true })
    mkdirSync(join(root, "users", "alice", "opencode-go"), { recursive: true })

    // Both CLIs read XDG_DATA_HOME: each status check must see its own login, not the one that happens to be last.
    const statuses = await statusesFor(root)
    expect(statuses.find((row) => row.provider === "opencode")).toMatchObject({ provider: "opencode", loggedIn: true, account: null })
    expect(statuses.find((row) => row.provider === "opencode-go")).toMatchObject({
      provider: "opencode-go",
      loggedIn: true,
      account: null,
    })
  })
})

describe.skipIf(process.platform === "win32")("missing harness CLI", () => {
  test("marks a CLI that is not on the box's PATH as unable to sign in", async () => {
    const statuses = await statusesFor(rootFor())
    expect(statuses.find((row) => row.provider === "codex-cli")).toMatchObject({
      loggedIn: false,
      cannotSignIn: true,
    })
    expect(statuses.find((row) => row.provider === "codex-cli")?.error).toContain("not installed")
  })
})

describe.skipIf(process.platform === "win32")("CLI probe pool", () => {
  test("a full discovery pool does not hold up a login status probe", async () => {
    const root = rootFor()
    const codex = join(root, "bin", "codex")
    writeFileSync(
      codex,
      [
        "#!/bin/sh",
        'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; fi',
        "exit 0",
        "",
      ].join("\n"),
    )
    chmodSync(codex, 0o755)
    mkdirSync(join(root, "users", "alice", "codex"), { recursive: true })

    // Hold every discovery slot: a probe sharing that pool could only answer after these are released.
    const releases: Array<() => void> = []
    const held = Array.from({ length: 4 }, () =>
      limitDiscovery(() => {
        const { promise, resolve } = Promise.withResolvers<void>()
        releases.push(resolve)
        return promise
      }),
    )
    try {
      const statuses = await statusesFor(root)
      expect(statuses.find((row) => row.provider === "codex-cli")).toMatchObject({ loggedIn: true })
    } finally {
      for (const release of releases) release()
      await Promise.all(held)
    }
  })
})

describe("Antigravity account label", () => {
  test("reports the signed-in Google email from the user's own login without exposing the credential", async () => {
    const root = rootFor()
    writeCredential(
      root,
      JSON.stringify({
        token: {
          access_token: "secret-access-token",
          token_type: "Bearer",
          refresh_token: "secret-refresh-token",
          expiry: "2030-01-01T00:00:00Z",
        },
        auth_method: "consumer",
        id_token: jwt({ email: "google-user@example.com", sub: "1234567890" }),
      }),
    )

    const statuses = await statusesFor(root)
    expect(antigravity(statuses)).toMatchObject({
      provider: "antigravity-cli",
      loggedIn: true,
      account: "google-user@example.com",
      activeAccountId: "default",
    })
    expect(antigravity(statuses).accounts).toEqual([{ id: "default", account: "google-user@example.com" }])
    expect(JSON.stringify(statuses)).not.toContain("secret-access-token")
    expect(JSON.stringify(statuses)).not.toContain("secret-refresh-token")
  })

  test("stays signed in with no account when the token has no usable identity", async () => {
    const root = rootFor()
    for (const credential of [
      JSON.stringify({ token: { access_token: "secret-access-token" }, auth_method: "consumer" }),
      JSON.stringify({ token: { access_token: "secret-access-token" }, id_token: "not.a.jwt" }),
      "{not json",
    ]) {
      writeCredential(root, credential)
      const status = antigravity(await statusesFor(root))
      expect(status.loggedIn).toBe(true)
      expect(status.account).toBeNull()
      expect(JSON.stringify(status)).not.toContain("secret-access-token")
    }
  })

  test("reports signed out when the user has no token file", async () => {
    const root = rootFor()
    expect(antigravity(await statusesFor(root))).toEqual({ provider: "antigravity-cli", loggedIn: false, account: null })
  })
})

/**
 * A stand-in for `agy acp --login`: it prints the Google link, reads codes from stdin, keeps waiting after a rejected
 * one, and stores the token only for the accepted code. Its identity is fixed per test through the linked JWT.
 */
const fakeAntigravity = (root: string, email: string): void => {
  const credentials = JSON.stringify({
    token: { access_token: "secret-access-token", token_type: "Bearer", refresh_token: "secret-refresh-token" },
    auth_method: "consumer",
    id_token: jwt({ email, sub: "1234567890" }),
  })
  const script = join(root, "fake-agy.ts")
  writeFileSync(script, `
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
if (!process.argv.includes("--login")) process.exit(1)
console.log("https://accounts.google.com/o/oauth2/auth?state=test")
for await (const code of console) {
  if (code.trim() !== "good-code") {
    console.log("Invalid code. Please make sure the full code was copied.")
    continue
  }
  const dir = join(process.env.AGY_GEMINI_DIR!, "antigravity-cli")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "antigravity-oauth-token"), ${JSON.stringify(credentials)})
  process.exit(0)
}
`)
  const agy = join(root, "bin", "agy")
  writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}" "$@"\n`)
  chmodSync(agy, 0o755)
}

const antigravityAccountDir = (root: string, accountId: string): string =>
  accountId === "default"
    ? join(root, "users", "alice", "antigravity")
    : join(root, "users", "alice", "accounts", accountId, "antigravity")

const antigravityToken = (root: string, accountId: string): string =>
  join(antigravityAccountDir(root, accountId), "antigravity-cli", "antigravity-oauth-token")

const writeAccountCredential = (root: string, accountId: string, email: string): void => {
  const path = antigravityToken(root, accountId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ token: { access_token: `secret-${accountId}` }, id_token: jwt({ email }) }))
}

describe("multiple page-auth accounts", () => {
  const runtimes: Array<ManagedRuntime.ManagedRuntime<CliAuth, never>> = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  })

  const authRuntime = (root: string) => {
    const config = {
      dataDir: root,
      sandbox: "off",
      sandboxPath: join(root, "bin"),
      sandboxSslCertFile: null,
    } as unknown as ServerConfig
    const runtime = ManagedRuntime.make(CliAuthLive.pipe(Layer.provide(Layer.succeed(Config, config))))
    runtimes.push(runtime)
    return <A, E>(f: (auth: Effect.Effect.Success<typeof CliAuth>) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(CliAuth, f))
  }

  const fakeClaudeStatus = (root: string) => {
    const script = join(root, "fake-claude.ts")
    writeFileSync(script, `
import { existsSync, renameSync, watch } from "node:fs"
import { join } from "node:path"
const root = ${JSON.stringify(root)}
const home = process.env.CLAUDE_CONFIG_DIR!
if (existsSync(join(home, "bad-status"))) {
  console.log("unreadable status")
  process.exit(0)
}
if (home === join(root, "users", "alice", "claude") && existsSync(join(root, "gate"))) {
  renameSync(join(root, "gate"), join(root, "blocked"))
  const released = Promise.withResolvers<void>()
  const watcher = watch(root, () => {
    if (existsSync(join(root, "release"))) { watcher.close(); released.resolve() }
  })
  if (existsSync(join(root, "release"))) { watcher.close(); released.resolve() }
  await released.promise
}
console.log(JSON.stringify({ loggedIn: true, email: home.includes("accttwo") ? "second@example.com" : "first@example.com" }))
`)
    const cli = join(root, "bin", "claude")
    writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}" "$@"\n`)
    chmodSync(cli, 0o755)
  }

  test("an older status probe cannot overwrite an explicit selection of a newly connected account", async () => {
    const root = rootFor()
    fakeClaudeStatus(root)
    mkdirSync(join(root, "users", "alice", "claude"), { recursive: true })
    writeFileSync(join(root, "gate"), "")
    const run = authRuntime(root)
    const blocked = Promise.withResolvers<void>()
    const watcher = watch(root, () => {
      if (existsSync(join(root, "blocked"))) blocked.resolve()
    })
    const stale = run((auth) => auth.status("alice"))
    try {
      await blocked.promise
      mkdirSync(join(root, "users", "alice", "accounts", "accttwo", "claude"), { recursive: true })
      const selected = await run((auth) => auth.selectAccount("alice", "claude-cli", "accttwo"))
      expect(selected.activeAccountId).toBe("accttwo")
    } finally {
      writeFileSync(join(root, "release"), "")
      watcher.close()
    }
    expect((await stale).find((status) => status.provider === "claude-cli")?.activeAccountId).toBe("accttwo")
    const stored = JSON.parse(readFileSync(join(root, "users", "alice", ".kestrel-cli-auth.json"), "utf8"))
    expect(stored.active["claude-cli"]).toBe("accttwo")
  })

  test("a failed status probe does not turn an unfinished account into a connected selection", async () => {
    const root = rootFor()
    fakeClaudeStatus(root)
    const unfinished = join(root, "users", "alice", "accounts", "unfinished", "claude")
    mkdirSync(unfinished, { recursive: true })
    writeFileSync(join(unfinished, "bad-status"), "")
    const run = authRuntime(root)
    const failure = await run((auth) => Effect.flip(auth.selectAccount("alice", "claude-cli", "unfinished")))
    expect(failure._tag).toBe("BadRequest")
    const status = (await run((auth) => auth.status("alice"))).find((row) => row.provider === "claude-cli")
    expect(status?.loggedIn).toBe(false)
    expect(status?.accounts).toBeUndefined()
    expect(existsSync(join(root, "users", "alice", ".kestrel-cli-auth.json"))).toBe(false)
  })

  test("lists isolated logins, switches the active one, and disconnects one account without touching the other", async () => {
    const root = rootFor()
    fakeAntigravity(root, "second@example.com")
    const run = authRuntime(root)
    writeCredential(root, JSON.stringify({ token: { access_token: "secret-default" }, id_token: jwt({ email: "first@example.com" }) }))
    writeAccountCredential(root, "accttwo", "second@example.com")

    const status = antigravity(await run((auth) => auth.status("alice")))
    expect(status).toMatchObject({ loggedIn: true, account: "first@example.com", activeAccountId: "default" })
    expect(status.accounts).toEqual([
      { id: "default", account: "first@example.com" },
      { id: "accttwo", account: "second@example.com" },
    ])
    expect(await run((auth) => auth.loggedInDirs("alice"))).toContainEqual({
      provider: "antigravity-cli",
      dir: antigravityAccountDir(root, "default"),
    })

    const selected = await run((auth) => auth.selectAccount("alice", "antigravity-cli", "accttwo"))
    expect(selected).toMatchObject({ loggedIn: true, account: "second@example.com", activeAccountId: "accttwo" })
    expect(await run((auth) => auth.loggedInDirs("alice"))).toContainEqual({
      provider: "antigravity-cli",
      dir: antigravityAccountDir(root, "accttwo"),
    })

    await run((auth) => auth.logout("alice", "antigravity-cli", "default"))
    const remaining = antigravity(await run((auth) => auth.status("alice")))
    expect(remaining).toMatchObject({ loggedIn: true, account: "second@example.com", activeAccountId: "accttwo" })
    expect(remaining.accounts?.map((account) => account.id)).toEqual(["accttwo"])
    expect(existsSync(antigravityToken(root, "default"))).toBe(false)
    expect(existsSync(antigravityToken(root, "accttwo"))).toBe(true)

    await run((auth) => auth.logout("alice", "antigravity-cli"))
    const none = antigravity(await run((auth) => auth.status("alice")))
    expect(none).toMatchObject({ loggedIn: false, account: null })
    expect(none.accounts).toBeUndefined()
    expect(existsSync(antigravityToken(root, "accttwo"))).toBe(false)
  })

  test("persists the selected account across a fresh CliAuth instance", async () => {
    const root = rootFor()
    writeCredential(root, JSON.stringify({ token: { access_token: "secret-default" }, id_token: jwt({ email: "first@example.com" }) }))
    writeAccountCredential(root, "accttwo", "second@example.com")
    const run = authRuntime(root)
    await run((auth) => auth.selectAccount("alice", "antigravity-cli", "accttwo"))
    const stored = JSON.parse(readFileSync(join(root, "users", "alice", ".kestrel-cli-auth.json"), "utf8"))
    expect(stored.active["antigravity-cli"]).toBe("accttwo")

    // A new process (or a restarted service) reads the same file.
    const restarted = antigravity(await statusesFor(root))
    expect(restarted).toMatchObject({ loggedIn: true, account: "second@example.com", activeAccountId: "accttwo" })
  })

  test("a selected but signed-out login is not handed to runs over a connected one", async () => {
    const root = rootFor()
    // The selection names a login whose credentials never completed, while another account is connected.
    mkdirSync(join(root, "users", "alice", "accounts", "signedout", "antigravity"), { recursive: true })
    writeAccountCredential(root, "accttwo", "second@example.com")
    writeFileSync(
      join(root, "users", "alice", ".kestrel-cli-auth.json"),
      JSON.stringify({ version: 1, active: { "antigravity-cli": "signedout" } }),
    )
    const run = authRuntime(root)
    expect(await run((auth) => auth.loggedInDirs("alice"))).toContainEqual({
      provider: "antigravity-cli",
      dir: antigravityAccountDir(root, "accttwo"),
    })
  })

  test("keeps the active login untouched while another sign-in is pending and completes it into an isolated account", async () => {
    const root = rootFor()
    fakeAntigravity(root, "second@example.com")
    const run = authRuntime(root)
    const legacy = JSON.stringify({ token: { access_token: "secret-default" }, id_token: jwt({ email: "first@example.com" }) })
    writeCredential(root, legacy)

    const start = await run((auth) => auth.startLogin("alice", "antigravity-cli"))
    expect(start.accountId).toBeTruthy()
    expect(start.accountId).not.toBe("default")
    if (start.accountId === undefined) throw new Error("sign-in did not identify its isolated account")
    expect(existsSync(antigravityToken(root, start.accountId!))).toBe(false)

    // The half-written account is not a connected login; the active one still is.
    const during = antigravity(await run((auth) => auth.status("alice")))
    expect(during).toMatchObject({ loggedIn: true, account: "first@example.com", activeAccountId: "default" })
    expect(during.accounts).toEqual([{ id: "default", account: "first@example.com" }])
    expect(await run((auth) => auth.loggedInDirs("alice"))).toContainEqual({
      provider: "antigravity-cli",
      dir: antigravityAccountDir(root, "default"),
    })

    // A rejected code leaves the pending sign-in retryable and the active login untouched.
    const failure = await run((auth) => Effect.flip(auth.submitCode("alice", "antigravity-cli", "bad-code", start.accountId)))
    expect(failure.message).toContain("Invalid code")
    expect(antigravity(await run((auth) => auth.status("alice")))).toMatchObject({
      loggedIn: true,
      account: "first@example.com",
      activeAccountId: "default",
    })

    const completed = await run((auth) => auth.submitCode("alice", "antigravity-cli", "good-code", start.accountId))
    expect(completed).toMatchObject({ loggedIn: true, account: "first@example.com", activeAccountId: "default" })
    expect(completed.accounts?.map((account) => account.id)).toEqual(["default", start.accountId])
    // The new login is isolated: the legacy credential bytes are unchanged and no token was copied into it.
    expect(readFileSync(antigravityToken(root, "default"), "utf8")).toBe(legacy)
    const isolated = JSON.parse(readFileSync(antigravityToken(root, start.accountId!), "utf8")) as { id_token: string }
    const claims = JSON.parse(Buffer.from(isolated.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string }
    expect(claims.email).toBe("second@example.com")

    // A retry/extra sign-in cancels only the pending attempt, never the selected login.
    await run((auth) => auth.selectAccount("alice", "antigravity-cli", start.accountId!))
    const retry = await run((auth) => auth.startLogin("alice", "antigravity-cli"))
    expect(retry.accountId).not.toBe(start.accountId)
    const afterRetry = antigravity(await run((auth) => auth.status("alice")))
    expect(afterRetry).toMatchObject({ loggedIn: true, account: "second@example.com", activeAccountId: start.accountId })
    expect(afterRetry.accounts?.map((account) => account.id)).toEqual(["default", start.accountId])
    await run((auth) => auth.shutdown())
  })

  test("an abandoned or replaced sign-in leaves no directory to probe", async () => {
    const root = rootFor()
    fakeAntigravity(root, "second@example.com")
    const run = authRuntime(root)
    const first = await run((auth) => auth.startLogin("alice", "antigravity-cli"))
    if (first.accountId === undefined) throw new Error("sign-in did not identify its isolated account")
    const firstHome = join(root, "users", "alice", "accounts", first.accountId)
    expect(existsSync(join(firstHome, CLI_PENDING_LOGIN_MARKER))).toBe(true)

    // A second attempt replaces the first, and the canceled attempt's home goes with it.
    const second = await run((auth) => auth.startLogin("alice", "antigravity-cli"))
    expect(existsSync(firstHome)).toBe(false)
    if (second.accountId === undefined) throw new Error("sign-in did not identify its isolated account")
    const secondHome = join(root, "users", "alice", "accounts", second.accountId)

    // While pending it is never listed as a login, and its live home is kept for the CLI to finish in.
    const during = antigravity(await run((auth) => auth.status("alice")))
    expect(during.loggedIn).toBe(false)
    expect(during.accounts).toBeUndefined()
    expect(existsSync(join(secondHome, CLI_PENDING_LOGIN_MARKER))).toBe(true)

    const completed = await run((auth) => auth.submitCode("alice", "antigravity-cli", "good-code", second.accountId))
    expect(completed.accounts?.map((account) => account.id)).toEqual([second.accountId])
    expect(existsSync(join(secondHome, CLI_PENDING_LOGIN_MARKER))).toBe(false)
  })

  test("a marked home left by a dead box is removed instead of being probed", async () => {
    const root = rootFor()
    const leftover = join(root, "users", "alice", "accounts", "abandoned")
    mkdirSync(join(leftover, "antigravity", "antigravity-cli"), { recursive: true })
    writeFileSync(join(leftover, CLI_PENDING_LOGIN_MARKER), "")
    const run = authRuntime(root)
    expect(antigravity(await run((auth) => auth.status("alice")))).toMatchObject({ loggedIn: false, account: null })
    expect(existsSync(leftover)).toBe(false)
  })

  test("canceling a sign-in stops its CLI and removes the unfinished home", async () => {
    const root = rootFor()
    fakeAntigravity(root, "second@example.com")
    const run = authRuntime(root)
    const start = await run((auth) => auth.startLogin("alice", "antigravity-cli"))
    if (start.accountId === undefined) throw new Error("sign-in did not identify its isolated account")
    const home = join(root, "users", "alice", "accounts", start.accountId)
    expect(existsSync(home)).toBe(true)

    await run((auth) => auth.cancelLogin("alice", "antigravity-cli"))
    expect(existsSync(home)).toBe(false)
    // The stopped CLI cannot take a code afterwards, so an approval on the page cannot silently add the account.
    const failure = await run((auth) => Effect.flip(auth.submitCode("alice", "antigravity-cli", "good-code", start.accountId)))
    expect(failure.message).toContain("no sign-in is pending")
    expect(antigravity(await run((auth) => auth.status("alice")))).toMatchObject({ loggedIn: false, account: null })
    // Cancelling again is a no-op.
    await run((auth) => auth.cancelLogin("alice", "antigravity-cli"))
  })
})

/**
 * A stand-in for `devin auth login --force-manual-token-flow`: like the real CLI it refuses to read the code without a
 * terminal, prints the sign-in link, and stores its credentials file only for an accepted code.
 */
const FAKE_DEVIN = `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$XDG_DATA_HOME/devin/credentials.toml" ] && read credential < "$XDG_DATA_HOME/devin/credentials.toml" && [ "$credential" = 'valid' ]; then
    echo 'Logged in (via test)'
  else
    echo 'Not logged in.'
  fi
  exit 0
fi
if [ "$1 $2" = "auth login" ]; then
  if [ ! -t 0 ]; then echo "Error: Failed to read code - user canceled"; exit 1; fi
  echo "Visit https://app.devin.ai/auth/cli/continue?state=abc&cli_pkce_marker=1 to sign in, then copy the code and paste it below."
  read code
  if [ "$code" = "good-code" ]; then
    printf 'valid\\n' > "$XDG_DATA_HOME/devin/credentials.toml"
    exit 0
  fi
  echo "Error: Failed to exchange code for host https://app.devin.ai"
  exit 1
fi
exit 0
`

// Terminal sign-in needs a real `script` to allocate the pseudo-terminal; skip where the host has none. Resolve it from
// the test host's PATH (NixOS keeps it outside /usr/bin and /bin) so the shim below can exec the same binary production finds.
const scriptPath = process.platform === "win32" ? null : findExecutable("script", process.env.PATH ?? "")
const hasScript = scriptPath !== null

describe.skipIf(!hasScript)("Devin sign-in", () => {
  const runtimes: Array<ManagedRuntime.ManagedRuntime<CliAuth, never>> = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  })

  const devinAuth = (root: string) => {
    writeFileSync(join(root, "bin", "devin"), FAKE_DEVIN)
    chmodSync(join(root, "bin", "devin"), 0o755)
    if (scriptPath === null) throw new Error("script is not installed on this host")
    // Record the SHELL `script` was given, then hand off to the real script resolved from the host PATH.
    const script = join(root, "bin", "script")
    writeFileSync(script, `#!/bin/sh\necho "SHELL=$SHELL" > "$HOME/script.log"\nexec '${scriptPath}' "$@"\n`)
    chmodSync(script, 0o755)
    const config = {
      dataDir: root,
      sandbox: "off",
      sandboxPath: `${join(root, "bin")}:/usr/bin:/bin`,
      sandboxSslCertFile: null,
    } as unknown as ServerConfig
    // One runtime for the whole sign-in: the pending CLI lives in the CliAuth instance that started it.
    const runtime = ManagedRuntime.make(CliAuthLive.pipe(Layer.provide(Layer.succeed(Config, config))))
    runtimes.push(runtime)
    return <A, E>(f: (auth: Effect.Effect.Success<typeof CliAuth>) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(CliAuth, f))
  }

  test("runs the CLI in a terminal, takes the pasted code and reads the stored credentials", async () => {
    const root = rootFor()
    const run = devinAuth(root)
    const start = await run((auth) => auth.startLogin("alice", "devin-cli"))
    expect(start).toMatchObject({
      provider: "devin-cli",
      url: "https://app.devin.ai/auth/cli/continue?state=abc&cli_pkce_marker=1",
      userCode: null,
      needsCode: true,
    })
    expect(start.accountId).toBeTruthy()
    if (start.accountId === undefined) throw new Error("sign-in did not identify its isolated account")
    expect(start.accountId).not.toBe("default")
    // The fake writes under its XDG data home, which the real CLI creates; the fixture cannot rely on host coreutils.
    mkdirSync(join(root, "users", "alice", "accounts", start.accountId, "devin", "devin"), { recursive: true })
    const status = await run((auth) => auth.submitCode("alice", "devin-cli", "good-code", start.accountId))
    expect(status).toMatchObject({ provider: "devin-cli", loggedIn: true, account: null })
    expect(status.activeAccountId).toBe(start.accountId)
    expect(status.accounts?.map((account) => account.id)).toEqual([start.accountId])
    expect(JSON.stringify(status)).not.toContain("secret-devin-token")
  })

  test("gives script a shell from the CLI toolchain, not the user's login shell", async () => {
    const root = rootFor()
    const run = devinAuth(root)
    const start = await run((auth) => auth.startLogin("alice", "devin-cli"))
    const shell = readFileSync(join(root, "users", "alice", "accounts", start.accountId!, "script.log"), "utf8").trim()
    expect(shell).toMatch(/(^|\/)(bash|sh)$/)
  })

  test("reports the CLI's refusal of a code without echoing it", async () => {
    const run = devinAuth(rootFor())
    await run((auth) => auth.startLogin("alice", "devin-cli"))
    const failure = await run((auth) => Effect.flip(auth.submitCode("alice", "devin-cli", "bad-code-123")))
    expect(failure.message).toContain("Failed to exchange code")
    expect(failure.message).not.toContain("bad-code-123")
    const statuses = await run((auth) => auth.status("alice"))
    expect(statuses.find((row) => row.provider === "devin-cli")).toEqual({ provider: "devin-cli", loggedIn: false, account: null })
  })

  test("does not treat an existing credentials file as a login", async () => {
    const root = rootFor()
    const run = devinAuth(root)
    await run((auth) => auth.startLogin("alice", "devin-cli"))
    const dir = join(root, "users", "alice", "devin", "devin")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "credentials.toml"), "")
    const statuses = await run((auth) => auth.status("alice"))
    expect(statuses.find((row) => row.provider === "devin-cli")).toEqual({ provider: "devin-cli", loggedIn: false, account: null })
  })
})

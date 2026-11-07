import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { CliAuthStatus } from "@cloudagents/protocol"
import type { ServerConfig } from "./config"
import { Config } from "./config"
import { CliAuth, CliAuthLive } from "./cliauth"
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
    expect(statuses.find((row) => row.provider === "opencode")).toEqual({ provider: "opencode", loggedIn: true, account: null })
    expect(statuses.find((row) => row.provider === "opencode-go")).toEqual({
      provider: "opencode-go",
      loggedIn: true,
      account: null,
    })
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
    expect(antigravity(statuses)).toEqual({
      provider: "antigravity-cli",
      loggedIn: true,
      account: "google-user@example.com",
    })
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
 * A stand-in for `devin auth login --force-manual-token-flow`: like the real CLI it refuses to read the code without a
 * terminal, prints the sign-in link, and stores its credentials file only for an accepted code.
 */
const FAKE_DEVIN = `#!/bin/sh
if [ "$1 $2" = "auth login" ]; then
  if [ ! -t 0 ]; then echo "Error: Failed to read code - user canceled"; exit 1; fi
  echo "Visit https://app.devin.ai/auth/cli/continue?state=abc&cli_pkce_marker=1 to sign in, then copy the code and paste it below."
  read code
  if [ "$code" = "good-code" ]; then
    mkdir -p "$XDG_DATA_HOME/devin"
    printf 'api_key = "secret-devin-token"\\n' > "$XDG_DATA_HOME/devin/credentials.toml"
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
    const run = devinAuth(rootFor())
    const start = await run((auth) => auth.startLogin("alice", "devin-cli"))
    expect(start).toMatchObject({
      provider: "devin-cli",
      url: "https://app.devin.ai/auth/cli/continue?state=abc&cli_pkce_marker=1",
      userCode: null,
      needsCode: true,
    })
    const status = await run((auth) => auth.submitCode("alice", "devin-cli", "good-code"))
    expect(status).toEqual({ provider: "devin-cli", loggedIn: true, account: null })
    expect(JSON.stringify(status)).not.toContain("secret-devin-token")
  })

  test("gives script a shell from the CLI toolchain, not the user's login shell", async () => {
    const root = rootFor()
    const run = devinAuth(root)
    await run((auth) => auth.startLogin("alice", "devin-cli"))
    const shell = readFileSync(join(root, "users", "alice", "script.log"), "utf8").trim()
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
})

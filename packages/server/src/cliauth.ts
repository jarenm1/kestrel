import { Effect } from "effect"
import { execFile } from "node:child_process"
import { InternalError, type CliAuthStatus } from "@cloudagents/protocol"

/*
 * Whether the agent CLIs are logged in on the box itself, as the box's own user (where a
 * subscription login lives; never the sandbox home). Only a login flag and an account label leave
 * this module: never tokens, key fragments or file contents.
 */

const TIMEOUT_MS = 15_000

interface Output {
  readonly stdout: string
  readonly stderr: string
}

/** Runs a CLI as the box user. Non-zero exits still yield output (both CLIs exit 1 when logged out); null when not installed. */
const run = (file: string, args: ReadonlyArray<string>): Effect.Effect<Output | null, InternalError> =>
  Effect.async<Output | null, InternalError>((resume) => {
    execFile(file, [...args], { env: process.env, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resume(Effect.succeed(null))
      if (err && err.killed) return resume(Effect.fail(new InternalError({ message: `${file}: timed out` })))
      resume(Effect.succeed({ stdout, stderr }))
    })
  })

const claude: Effect.Effect<CliAuthStatus, InternalError> = Effect.gen(function* () {
  const out = yield* run("claude", ["auth", "status", "--json"])
  if (out === null) return { provider: "claude-cli", loggedIn: false, account: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout)
  } catch {
    return yield* Effect.fail(new InternalError({ message: "claude auth status: unreadable output" }))
  }
  if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed) || typeof parsed.loggedIn !== "boolean") {
    return yield* Effect.fail(new InternalError({ message: "claude auth status: unexpected output" }))
  }
  const field = (name: string): string | null => {
    const value = (parsed as Record<string, unknown>)[name]
    return typeof value === "string" && value !== "" ? value : null
  }
  // claude.ai logins carry email/orgName; API-key logins only an auth method.
  const account = parsed.loggedIn ? (field("email") ?? field("orgName") ?? field("authMethod")) : null
  return { provider: "claude-cli", loggedIn: parsed.loggedIn, account }
})

const codex: Effect.Effect<CliAuthStatus, InternalError> = Effect.gen(function* () {
  const out = yield* run("codex", ["login", "status"])
  if (out === null) return { provider: "codex-cli", loggedIn: false, account: null }
  const text = `${out.stdout}\n${out.stderr}`
  if (/^Not logged in/m.test(text)) return { provider: "codex-cli", loggedIn: false, account: null }
  // e.g. "Logged in using ChatGPT", "Logged in using an API key - sk-…": the part after " - " is
  // a key fragment and is dropped.
  const match = /^Logged in using (?:an? )?(.+?)(?: - .*)?$/m.exec(text)
  if (!match) return yield* Effect.fail(new InternalError({ message: "codex login status: unexpected output" }))
  return { provider: "codex-cli", loggedIn: true, account: match[1] ?? null }
})

export const cliAuthStatus = (): Effect.Effect<ReadonlyArray<CliAuthStatus>, InternalError> =>
  Effect.all([claude, codex], { concurrency: "unbounded" })

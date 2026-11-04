import { api } from "./api"
import { CommandError, SilentExit, type GhRun } from "./context"
import { errorMessage, PR_COMMANDS, PR_UNAVAILABLE } from "./pr"
import { GH_VERSION_TEXT } from "./usage"

export interface GhResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const SUPPORTED = ["checks", "close", "comment", "create", "diff", "edit", "list", "ready", "reopen", "review", "status", "view"]

const GH_HELP = `Work with GitHub from this Kestrel thread.

This gh behaves like GitHub CLI 2.87.3 for the commands below. It acts with the thread owner's GitHub
connection; no token is visible inside the sandbox.

USAGE
  gh <command> <subcommand> [flags]

COMMANDS
  api:         Make a read-only GitHub API request (GET or HEAD, or a GraphQL query)
  pr:          Work with pull requests in this thread's checkouts

Run \`gh <command> --help\` for a command's flags.
`

const PR_HELP = `Work with GitHub pull requests in this Kestrel thread's checkouts.

This gh behaves like GitHub CLI 2.87.3 for the commands below. It acts with the thread owner's GitHub
connection; no token is visible inside the sandbox.

USAGE
  gh pr <command> [flags]

COMMANDS
  checks:      Show CI status for a single pull request
  close:       Close a pull request
  comment:     Add a comment to a pull request
  create:      Create a pull request
  diff:        View changes in a pull request
  edit:        Edit a pull request
  list:        List pull requests in a repository
  ready:       Mark a pull request as ready for review
  reopen:      Reopen a pull request
  review:      Add a review to a pull request
  status:      Show status of relevant pull requests
  view:        View a pull request

INHERITED FLAGS
      --help                     Show help for command
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format

Run \`gh pr <command> --help\` for a command's flags.
`

const unavailable = (what: string): string =>
  `${what} is not available in Kestrel. Kestrel's gh supports gh api (read-only) and gh pr ${SUPPORTED.join(", ")}; use the github_* tools for other GitHub work.`

/** Runs one `gh` command line for an agent and collects what it would print. */
export const runGh = async (run: GhRun, argv: ReadonlyArray<string>): Promise<GhResult> => {
  const result = (exitCode: number): GhResult => ({ stdout: run.stdout, stderr: run.stderr, exitCode })
  try {
    const [command, ...rest] = argv
    if (command === undefined || command === "--help" || command === "help") {
      run.stdout += GH_HELP
      return result(0)
    }
    if (command === "--version" || command === "version") {
      run.stdout += GH_VERSION_TEXT
      return result(0)
    }
    if (command === "auth") {
      if (rest[0] === "status") {
        run.stdout += "github.com\n  ✓ Logged in to github.com through Kestrel (the thread owner's GitHub connection)\n"
        return result(0)
      }
      throw new CommandError(unavailable(`gh auth ${rest[0] ?? ""}`.trimEnd()))
    }
    if (command === "api") {
      await api(run, rest)
      return result(0)
    }
    if (command !== "pr") throw new CommandError(unavailable(`gh ${command}`))

    // `-R` may come before the subcommand, as cobra allows for persistent flags.
    const leading: string[] = []
    let i = 0
    while (i < rest.length) {
      const arg = rest[i] as string
      if ((arg === "-R" || arg === "--repo") && i + 1 < rest.length) {
        leading.push(arg, rest[i + 1] as string)
        i += 2
      } else if (arg.startsWith("--repo=") || (arg.startsWith("-R") && arg.length > 2)) {
        leading.push(arg)
        i++
      } else break
    }
    const sub = rest[i]
    if (sub === undefined || sub === "--help" || sub === "help") {
      run.stdout += PR_HELP
      return result(0)
    }
    const handler = PR_COMMANDS[sub]
    if (handler === undefined) {
      if (PR_UNAVAILABLE.includes(sub)) throw new CommandError(unavailable(`gh pr ${sub}`))
      throw new CommandError(
        `unknown command "${sub}" for "gh pr"\n\nUsage:  gh pr <command> [flags]\n\nAvailable commands:\n${SUPPORTED.map((c) => `  ${c}\n`).join("")}`,
      )
    }
    await handler(run, [...rest.slice(i + 1), ...leading])
    return result(0)
  } catch (error) {
    if (error instanceof SilentExit) return result(error.code)
    const message = errorMessage(error)
    run.stderr += message.endsWith("\n") ? message : `${message}\n`
    if (error instanceof CommandError && error.usage !== null) run.stderr += `${message.endsWith("\n") ? "" : "\n"}${error.usage}`
    return result(1)
  }
}

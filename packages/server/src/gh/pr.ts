/**
 * `gh pr` subcommands, reproducing GitHub CLI 2.87.3 as it behaves with stdout not a terminal: the same flags,
 * validation order, messages, output bytes and exit codes. Where Kestrel deliberately differs (no browser, no
 * editor, no approvals, only the thread's checkouts), the command says so and exits 1.
 */
import { bool, FlagParseError, flagReader, int, oneOf, parseFlags, slice, str, type FlagReader, type FlagSpec } from "./argv"
import {
  CommandError,
  findPullRequest,
  fullName,
  graphql,
  loadProjectItems,
  NotFoundError,
  resolveRepo,
  SilentExit,
  type GhRun,
} from "./context"
import {
  arr,
  b,
  exportPullRequest,
  headLabel,
  n,
  nodes,
  obj,
  objOrNull,
  PULL_REQUEST_FIELDS,
  pullRequestGraphQL,
  requiredStatusCheckRollupFields,
  rollupContexts,
  s,
  sortedMap,
  squashWhitespace,
  stateWithDraft,
  time,
} from "./fields"
import { encodeJson, evaluateJq } from "./json"
import { HELP, USAGE } from "./usage"

type Raw = Record<string, unknown>

// ---- shared plumbing ----

const HELP_FLAG = bool("help")
const REPO_FLAG = str("repo", "R")
const JSON_FLAGS = [slice("json"), str("jq", "q"), str("template", "t")]

/** Go's `%q` for the strings these messages quote. */
const quote = (text: string): string => JSON.stringify(text)

const flagError = (command: string, message: string): CommandError => new CommandError(message, USAGE[command] ?? null)

const noBrowser = (): CommandError => new CommandError("--web is not available in Kestrel: agents have no browser")

interface Parsed {
  readonly f: FlagReader
  readonly args: ReadonlyArray<string>
}

/** Parses the command line; `null` means `--help` was answered. */
const parse = (run: GhRun, command: string, argv: ReadonlyArray<string>, specs: ReadonlyArray<FlagSpec>, jsonFields?: ReadonlyArray<string>): Parsed | null => {
  let parsed
  try {
    parsed = parseFlags(argv, [...specs, HELP_FLAG, REPO_FLAG])
  } catch (error) {
    if (!(error instanceof FlagParseError)) throw error
    if (jsonFields !== undefined && error.message === "flag needs an argument: --json") {
      throw new CommandError(`Specify one or more comma-separated fields for \`--json\`:\n  ${[...jsonFields].sort().join("\n  ")}`)
    }
    throw flagError(command, error.message)
  }
  const f = flagReader(parsed)
  if (f.bool("help")) {
    run.stdout += HELP[command] ?? ""
    return null
  }
  return { f, args: parsed.args }
}

const maxArgs = (args: ReadonlyArray<string>, max: number): void => {
  if (args.length > max) throw new CommandError(`accepts at most ${max} arg(s), received ${args.length}`)
}

/** `cmdutil.NoArgsQuoteReminder`. */
const noArgs = (command: string, parsed: Parsed, specs: ReadonlyArray<FlagSpec>): void => {
  const { args, f } = parsed
  if (args.length === 0) return
  let message = args.length === 1 ? `unknown argument ${quote(args[0] as string)}` : `unknown arguments [${args.map(quote).join(" ")}]`
  if ([...specs, REPO_FLAG].some((spec) => spec.kind.type !== "bool" && f.changed(spec.long))) {
    message += "; please quote all values that have spaces"
  }
  throw flagError(command, message)
}

interface JsonOptions {
  readonly fields: ReadonlyArray<string>
  readonly filter: string
}

/** `checkJSONFlags` plus the field check of `setupJsonFlags`. */
const jsonOptions = (f: FlagReader, allowed: ReadonlyArray<string>): JsonOptions | null => {
  if (f.changed("json")) {
    if (f.bool("web")) throw new CommandError("cannot use `--web` with `--json`")
    const fields = f.slice("json")
    for (const field of fields) {
      if (!allowed.includes(field)) {
        throw new CommandError(`Unknown JSON field: ${quote(field)}\nAvailable fields:\n  ${[...allowed].sort().join("\n  ")}`)
      }
    }
    if (f.string("template") !== "") throw new CommandError("--template is not available in Kestrel's gh; use --jq to shape JSON output")
    return { fields, filter: f.string("jq") }
  }
  if (f.changed("jq")) throw new CommandError("cannot use `--jq` without specifying `--json`")
  if (f.changed("template")) throw new CommandError("cannot use `--template` without specifying `--json`")
  return null
}

/** `jsonExporter.Write`: the encoded JSON, or the jq filter's results over it. */
const writeJson = async (run: GhRun, data: unknown, json: JsonOptions): Promise<void> => {
  const encoded = encodeJson(data)
  if (json.filter === "") {
    run.stdout += encoded
    return
  }
  const result = await evaluateJq(JSON.parse(encoded), json.filter)
  if (!result.ok) throw new CommandError(result.stderr.replace(/\n$/, ""))
  run.stdout += result.stdout
}

/** `cmdutil.ReadFile`: `-` is standard input; any other path was read by the shim inside the sandbox. */
const readBodyFile = (run: GhRun, path: string): string => {
  const content = run.files.get(path)
  if (content === undefined || content === null) throw new CommandError(`open ${path}: no such file or directory`)
  return content
}

const apiFailed = (error: unknown): CommandError => new CommandError(`API call failed: ${errorMessage(error)}`)

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `text.Title` for the all-caps enum values it is used on. */
const title = (value: string): string => value.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())

/** Splits reviewer handles into users and team slugs (`org/team`). */
const reviewerRequest = (handles: ReadonlyArray<string>) => ({
  reviewers: handles.filter((h) => !h.includes("/")),
  teamReviewers: handles.filter((h) => h.includes("/")).map((h) => h.slice(h.indexOf("/") + 1)),
})

// ---- gh pr view ----

const VIEW_SPECS = [bool("web", "w"), bool("comments", "c"), ...JSON_FLAGS]

/** What the plain preview and `--comments` print. */
const VIEW_FIELDS = [
  "url",
  "number",
  "title",
  "state",
  "body",
  "author",
  "autoMergeRequest",
  "isDraft",
  "additions",
  "deletions",
  "reviewRequests",
  "reviews",
  "assignees",
  "labels",
  "projectItems",
  "milestone",
  "comments",
]

const view = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "view", argv, VIEW_SPECS, PULL_REQUEST_FIELDS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  const json = jsonOptions(f, PULL_REQUEST_FIELDS)
  if (f.string("repo") !== "" && args.length === 0) throw flagError("view", "argument required when using the --repo flag")
  if (f.bool("web")) throw noBrowser()

  const fields = json?.fields ?? VIEW_FIELDS
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields })
  if (fields.includes("projectItems")) pr.projectItems = { nodes: await loadProjectItems(run, repo, n(pr.number)) }

  if (json !== null) return writeJson(run, exportPullRequest(pr, json.fields), json)
  if (f.bool("comments")) {
    run.stdout += rawCommentList(pr)
    return
  }
  run.stdout += rawPreview(pr)
}

const reviewerList = (pr: Raw): string => {
  const author = s(obj(pr.author).login)
  const states = new Map<string, string>()
  for (const review of nodes(pr.reviews)) {
    const login = s(obj(review.author).login)
    if (login === author) continue
    states.set(login === "" ? "ghost" : login, s(review.state))
  }
  for (const request of nodes(pr.reviewRequests)) {
    const r = obj(request.requestedReviewer)
    states.set(s(r.__typename) === "Team" ? `${s(obj(r.organization).login)}/${s(r.slug)}` : s(r.login), "REQUESTED")
  }
  const list = [...states].filter(([, state]) => state !== "PENDING")
  // Go's sort.Slice with this comparator; insertion order is the map's, which Go randomizes, so names decide.
  list.sort(([nameA, stateA], [nameB, stateB]) => {
    const requestedA = stateA === "REQUESTED"
    const requestedB = stateB === "REQUESTED"
    if (requestedA !== requestedB) return requestedA ? 1 : -1
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
  })
  return list
    .map(([name, state]) => {
      const shown =
        state === "REQUESTED"
          ? "Requested"
          : state === "APPROVED"
            ? "Approved"
            : state === "CHANGES_REQUESTED"
              ? "Changes requested"
              : state === "COMMENTED" || state === "DISMISSED"
                ? "Commented"
                : title(state)
      return `${name} (${shown})`
    })
    .join(", ")
}

const moreMarker = (connection: unknown, shown: number): string => (n(obj(connection).totalCount) > shown ? ", …" : "")

const rawPreview = (pr: Raw): string => {
  const labels = [...nodes(pr.labels)]
  labels.sort((x, y) => {
    const a = s(x.name).toLowerCase()
    const c = s(y.name).toLowerCase()
    return a < c ? -1 : a > c ? 1 : 0
  })
  const assignees = nodes(pr.assignees)
  const projects = nodes(pr.projectItems).map((item) => {
    const status = s(obj(item.status).name)
    return `${s(obj(item.project).title)} (${status === "" ? "No Status" : status})`
  })
  const autoMerge = objOrNull(pr.autoMergeRequest)
  const lines = [
    `title:\t${s(pr.title)}`,
    `state:\t${stateWithDraft(pr)}`,
    `author:\t${s(obj(pr.author).login)}`,
    `labels:\t${labels.length === 0 ? "" : labels.map((l) => s(l.name)).join(", ") + moreMarker(pr.labels, labels.length)}`,
    `assignees:\t${assignees.length === 0 ? "" : assignees.map((a) => s(a.login)).join(", ") + moreMarker(pr.assignees, assignees.length)}`,
    `reviewers:\t${reviewerList(pr)}`,
    `projects:\t${projects.join(", ")}`,
    `milestone:\t${s(objOrNull(pr.milestone)?.title)}`,
    `number:\t${n(pr.number)}`,
    `url:\t${s(pr.url)}`,
    `additions:\t${n(pr.additions)}`,
    `deletions:\t${n(pr.deletions)}`,
    `auto-merge:\t${autoMerge === null ? "disabled" : `enabled\t${s(obj(autoMerge.enabledBy).login)}\t${s(autoMerge.mergeMethod).toLowerCase()}`}`,
    "--",
    s(pr.body),
  ]
  return `${lines.join("\n")}\n`
}

const RAW_REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]

/** `shared.RawCommentList` over the comments and the displayable reviews, oldest first. */
const rawCommentList = (pr: Raw): string => {
  const comments = nodes(pr.comments).map((c) => ({
    created: time(c.createdAt),
    hidden: b(c.isMinimized),
    author: s(obj(c.author).login),
    association: s(c.authorAssociation),
    edited: b(c.includesCreatedEdit),
    status: "",
    body: s(c.body),
  }))
  const reviews = nodes(pr.reviews)
    .filter((r) => s(r.state) !== "PENDING" && !(s(r.state) === "COMMENTED" && s(r.body) === ""))
    .map((r) => ({
      created: time(r.submittedAt),
      hidden: false,
      author: s(obj(r.author).login),
      association: s(r.authorAssociation),
      edited: b(r.includesCreatedEdit),
      status: s(r.state),
      body: s(r.body),
    }))
  const all = [...comments, ...reviews].sort((x, y) => Date.parse(x.created) - Date.parse(y.created))
  return all
    .filter((c) => !c.hidden)
    .map((c) => {
      const status = RAW_REVIEW_STATES.includes(c.status) ? c.status.toLowerCase().replace(/_/g, " ") : "none"
      return `author:\t${c.author}\nassociation:\t${c.association.toLowerCase()}\nedited:\t${c.edited}\nstatus:\t${status}\n--\n${c.body}\n--\n`
    })
    .join("")
}

// ---- gh pr checks ----

const CHECK_FIELDS = ["name", "state", "startedAt", "completedAt", "link", "bucket", "event", "workflow", "description"]

const CHECKS_SPECS = [bool("web", "w"), bool("watch"), bool("fail-fast"), int("interval", "i"), bool("required"), ...JSON_FLAGS]

interface Check {
  readonly name: string
  readonly state: string
  readonly startedAt: string
  readonly completedAt: string
  readonly link: string
  readonly bucket: string
  readonly event: string
  readonly workflow: string
  readonly description: string
}

interface CheckCounts {
  failed: number
  passed: number
  pending: number
  skipping: number
  canceled: number
}

/** Go's `time.Duration.String` for whole seconds and up. */
const goDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const total = ms / 1000
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const secondsText = `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(9))}s`
  if (hours > 0) return `${hours}h${minutes}m${secondsText}`
  if (minutes > 0) return `${minutes}m${secondsText}`
  return secondsText
}

const ZERO_TIME = "0001-01-01T00:00:00Z"

/** Go's insertion sort (what `sort.Slice` uses for short slices): stable for elements `less` cannot order. */
const insertionSort = <T>(items: T[], less: (a: T, b: T) => boolean): T[] => {
  for (let i = 1; i < items.length; i++) {
    for (let j = i; j > 0 && less(items[j] as T, items[j - 1] as T); j--) {
      const swap = items[j] as T
      items[j] = items[j - 1] as T
      items[j - 1] = swap
    }
  }
  return items
}

/** `aggregateChecks` after `eliminateDuplicates`. */
const aggregateChecks = (contexts: ReadonlyArray<Raw>, requiredOnly: boolean): { checks: Check[]; counts: CheckCounts } => {
  const sorted = insertionSort([...contexts], (x, y) => Date.parse(time(x.startedAt)) > Date.parse(time(y.startedAt)))
  const seenChecks = new Set<string>()
  const seenContexts = new Set<string>()
  const counts: CheckCounts = { failed: 0, passed: 0, pending: 0, skipping: 0, canceled: 0 }
  const checks: Check[] = []
  for (const c of sorted) {
    const workflowRun = obj(obj(c.checkSuite).workflowRun)
    const workflow = s(obj(workflowRun.workflow).name)
    const event = s(workflowRun.event)
    if (s(c.context) !== "") {
      if (seenContexts.has(s(c.context))) continue
      seenContexts.add(s(c.context))
    } else {
      const key = `${s(c.name)}/${workflow}/${event}`
      if (seenChecks.has(key)) continue
      seenChecks.add(key)
    }
    if (requiredOnly && !b(c.isRequired)) continue
    let state = s(c.state)
    if (state === "") state = s(c.status) === "COMPLETED" ? s(c.conclusion) : s(c.status)
    let bucket: string
    switch (state) {
      case "SUCCESS":
        bucket = "pass"
        counts.passed++
        break
      case "SKIPPED":
      case "NEUTRAL":
        bucket = "skipping"
        counts.skipping++
        break
      case "ERROR":
      case "FAILURE":
      case "TIMED_OUT":
      case "ACTION_REQUIRED":
        bucket = "fail"
        counts.failed++
        break
      case "CANCELLED":
        bucket = "cancel"
        counts.canceled++
        break
      default:
        bucket = "pending"
        counts.pending++
    }
    checks.push({
      name: s(c.name) === "" ? s(c.context) : s(c.name),
      state,
      startedAt: time(c.startedAt),
      completedAt: time(c.completedAt),
      link: s(c.detailsUrl) === "" ? s(c.targetUrl) : s(c.detailsUrl),
      bucket,
      event,
      workflow,
      description: s(c.description),
    })
  }
  return { checks, counts }
}

const checksTable = (checks: Check[]): string => {
  insertionSort(checks, (x, y) => {
    if (x.bucket === y.bucket) return x.name === y.name ? x.link < y.link : x.name < y.name
    return x.bucket === "fail" || (x.bucket === "pending" && y.bucket === "success")
  })
  return checks
    .map((c) => {
      let elapsed = ""
      if (c.startedAt !== ZERO_TIME && c.completedAt !== ZERO_TIME) {
        const ms = Date.parse(c.completedAt) - Date.parse(c.startedAt)
        if (ms > 0) elapsed = goDuration(ms)
      }
      return `${c.name}\t${c.bucket === "cancel" ? "fail" : c.bucket}\t${elapsed === "" ? "0" : elapsed}\t${c.link}\t${c.description}\n`
    })
    .join("")
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => {
    clearTimeout(timer)
    resolve()
  })
  return promise
}

const checks = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "checks", argv, CHECKS_SPECS, CHECK_FIELDS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  const json = jsonOptions(f, CHECK_FIELDS)
  const watch = f.bool("watch")
  if (json !== null && watch) throw flagError("checks", "cannot use `--watch` with `--json` flag")
  if (f.string("repo") !== "" && args.length === 0) throw flagError("checks", "argument required when using the `--repo` flag")
  if (f.bool("fail-fast") && !watch) throw flagError("checks", "cannot use `--fail-fast` flag without `--watch` flag")
  if (!watch && f.changed("interval")) throw flagError("checks", "cannot use `--interval` flag without `--watch` flag")
  const interval = f.int("interval", 10)
  if (f.bool("web")) throw noBrowser()

  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["number", "headRefName"] })
  const populate = async () => {
    const contexts: Raw[] = []
    let after: string | null = null
    while (true) {
      const data = await graphql(
        run,
        repo,
        `
	query PullRequestStatusChecks($id: ID!, $endCursor: String) {
		node(id: $id) {
			...on PullRequest {
				${requiredStatusCheckRollupFields("$id", "$endCursor")}
			}
		}
	}`,
        after === null ? { id: s(pr.id) } : { id: s(pr.id), endCursor: after },
      )
      const node = obj(data.node)
      if (nodes(node.statusCheckRollup).length === 0) throw new CommandError("no commit found on the pull request")
      const page = rollupContexts(node) ?? []
      contexts.push(...page)
      const [commit] = nodes(node.statusCheckRollup)
      const info = obj(obj(obj(obj(commit).commit).statusCheckRollup).contexts).pageInfo
      if (!b(obj(info).hasNextPage)) break
      after = s(obj(info).endCursor)
    }
    if (contexts.length === 0) throw new CommandError(`no checks reported on the '${s(pr.headRefName)}' branch`)
    const result = aggregateChecks(contexts, f.bool("required"))
    if (result.checks.length === 0 && f.bool("required")) {
      throw new CommandError(`no required checks reported on the '${s(pr.headRefName)}' branch`)
    }
    return result
  }

  let { checks: list, counts } = await populate()
  if (json !== null) {
    return writeJson(
      run,
      list.map((c) => sortedMap(Object.fromEntries(json.fields.map((field) => [field, c[field as keyof Check]])))),
      json,
    )
  }
  while (true) {
    if (counts.pending !== 0 && watch) {
      run.stdout += `Refreshing checks status every ${interval} seconds. Press Ctrl+C to quit.\n\n`
    }
    run.stdout += checksTable(list)
    if (counts.pending === 0 || !watch) break
    if (f.bool("fail-fast") && counts.failed > 0) break
    await sleep(interval * 1000, run.signal)
    if (run.signal.aborted) throw new SilentExit(1)
    ;({ checks: list, counts } = await populate())
  }
  if (watch) run.stdout += checksTable(list)
  if (counts.failed > 0) throw new SilentExit(1)
  if (counts.pending > 0) throw new SilentExit(8)
}

// ---- gh pr list ----

const LIST_SPECS = [
  bool("web", "w"),
  int("limit", "L"),
  oneOf("state", "s", ["open", "closed", "merged", "all"]),
  str("base", "B"),
  str("head", "H"),
  slice("label", "l"),
  str("author", "A"),
  str("app"),
  str("assignee", "a"),
  str("search", "S"),
  bool("draft", "d"),
  ...JSON_FLAGS,
]

const LIST_DEFAULT_FIELDS = ["number", "title", "state", "url", "headRefName", "headRepositoryOwner", "isCrossRepository", "isDraft", "createdAt"]

/** `shared.QueryHasStateClause`. */
const hasStateClause = (search: string): boolean =>
  search
    .split(/\s+/)
    .some(
      (arg) =>
        arg === "is:closed" || arg === "is:merged" || arg === "state:closed" || arg === "state:merged" || arg.startsWith("merged:") || arg.startsWith("closed:"),
    )

/** A search query may not reach past the repository: no repository qualifiers, no unbalanced parentheses. */
const checkSearchScope = (search: string): void => {
  if (/(^|[\s(])-?(repo|org|user|owner):/i.test(search)) {
    throw new CommandError("--search may not name repositories, users or organizations in Kestrel: gh works on this thread's checkouts only")
  }
  let depth = 0
  let quoted = false
  for (const c of search) {
    if (c === '"') quoted = !quoted
    else if (!quoted && c === "(") depth++
    else if (!quoted && c === ")" && --depth < 0) break
  }
  if (depth !== 0) throw new CommandError("--search with unbalanced parentheses is not supported in Kestrel")
}

const searchQuote = (v: string): string => (/[ "\t\r\n]/.test(v) ? quote(v) : v)

/** `SearchQueryBuild` with the advanced issue search syntax github.com uses. */
const searchQuery = (filters: { state: string; author: string; assignee: string; base: string; head: string; labels: ReadonlyArray<string>; draft: boolean | null; repo: string; search: string }): string => {
  const qualifiers: Array<[string, string[]]> = []
  const add = (key: string, values: ReadonlyArray<string>) => {
    const present = values.filter((v) => v !== "")
    if (present.length > 0) qualifiers.push([key, present.map((v) => `${key}:${searchQuote(v)}`).sort()])
  }
  add("assignee", [filters.assignee])
  add("author", [filters.author])
  add("base", [filters.base])
  if (filters.draft !== null) add("draft", [String(filters.draft)])
  add("head", [filters.head])
  add("is", [filters.state === "merged" ? "merged" : ""])
  add("label", filters.labels)
  add("repo", [filters.repo])
  add("state", [filters.state === "open" || filters.state === "closed" ? filters.state : ""])
  add("type", ["pr"])
  const text = qualifiers
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .flatMap(([, values]) => values)
    .join(" ")
  return filters.search === "" ? text : `( ${filters.search} ) ${text}`
}

const list = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "list", argv, LIST_SPECS, PULL_REQUEST_FIELDS)
  if (parsed === null) return
  const { f } = parsed
  noArgs("list", parsed, LIST_SPECS)
  const json = jsonOptions(f, PULL_REQUEST_FIELDS)
  const limit = f.int("limit", 30)
  if (limit < 1) throw flagError("list", `invalid value for --limit: ${limit}`)
  if (f.changed("author") && f.changed("app")) throw flagError("list", "specify only `--author` or `--app`")
  if (f.bool("web")) throw noBrowser()
  const author = f.changed("app") ? `app/${f.string("app")}` : f.string("author")
  const repo = await resolveRepo(run, f.string("repo"))

  const search = f.string("search")
  let state = f.string("state", "open").toLowerCase()
  if (state === "open" && hasStateClause(search)) state = ""
  const draft = f.changed("draft") ? f.bool("draft") : null
  const fields = new Set(json?.fields ?? LIST_DEFAULT_FIELDS)
  fields.add("url")
  const useSearch = draft !== null || author !== "" || f.string("assignee") !== "" || search !== "" || f.slice("label").length > 0

  const prs: Raw[] = []
  const seen = new Set<number>()
  let after: string | null = null
  let pageLimit = Math.min(limit, 100)
  const prefix = `https://github.com/${repo.owner}/${repo.name}/pull/`.toLowerCase()
  loop: while (true) {
    let connection: Raw
    if (useSearch) {
      checkSearchScope(search)
      const data = await graphql(
        run,
        repo,
        `fragment pr on PullRequest{${pullRequestGraphQL(fields)}}
		query PullRequestSearch(
			$q: String!,
			$type: SearchType!,
			$limit: Int!,
			$endCursor: String,
		) {
			search(query: $q, type: $type, first: $limit, after: $endCursor) {
				issueCount
				nodes {
					...pr
				}
				pageInfo {
					hasNextPage
					endCursor
				}
			}
		}`,
        {
          q: searchQuery({ state, author, assignee: f.string("assignee"), base: f.string("base"), head: f.string("head"), labels: f.slice("label"), draft, repo: fullName(repo), search }),
          type: "ISSUE_ADVANCED",
          limit: pageLimit,
          ...(after === null ? {} : { endCursor: after }),
        },
      )
      connection = obj(data.search)
    } else {
      const states: Record<string, string[]> = { open: ["OPEN"], closed: ["CLOSED", "MERGED"], merged: ["MERGED"], all: ["OPEN", "CLOSED", "MERGED"] }
      const data = await graphql(
        run,
        repo,
        `fragment pr on PullRequest{${pullRequestGraphQL(fields)}}
		query PullRequestList(
			$owner: String!,
			$repo: String!,
			$limit: Int!,
			$endCursor: String,
			$baseBranch: String,
			$headBranch: String,
			$state: [PullRequestState!] = OPEN
		) {
			repository(owner: $owner, name: $repo) {
				pullRequests(
					states: $state,
					baseRefName: $baseBranch,
					headRefName: $headBranch,
					first: $limit,
					after: $endCursor,
					orderBy: {field: CREATED_AT, direction: DESC}
				) {
					totalCount
					nodes {
						...pr
					}
					pageInfo {
						hasNextPage
						endCursor
					}
				}
			}
		}`,
        {
          owner: repo.owner,
          repo: repo.name,
          limit: pageLimit,
          state: states[state] ?? ["OPEN"],
          ...(f.string("base") === "" ? {} : { baseBranch: f.string("base") }),
          ...(f.string("head") === "" ? {} : { headBranch: f.string("head") }),
          ...(after === null ? {} : { endCursor: after }),
        },
      )
      connection = obj(obj(obj(data.repository).pullRequests))
    }
    for (const pr of nodes(connection)) {
      // Search results are confined to the repository by the query; check anyway.
      if (!s(pr.url).toLowerCase().startsWith(prefix)) continue
      if (n(pr.number) > 0 && seen.has(n(pr.number))) continue
      seen.add(n(pr.number))
      prs.push(pr)
      if (prs.length === limit) break loop
    }
    const info = obj(connection.pageInfo)
    if (!b(info.hasNextPage)) break
    after = s(info.endCursor)
    pageLimit = Math.min(pageLimit, limit - prs.length)
  }

  if (json !== null) return writeJson(run, prs.map((pr) => exportPullRequest(pr, json.fields)), json)
  // No results is not a failure; without a terminal the CLI says nothing.
  if (prs.length === 0) return
  if (limit > 1000 && useSearch) run.stderr += "warning: this query uses the Search API which is capped at 1000 results maximum\n"
  run.stdout += prs
    .map((pr) => `${n(pr.number)}\t${squashWhitespace(s(pr.title))}\t${headLabel(pr)}\t${stateWithDraft(pr)}\t${time(pr.createdAt)}\n`)
    .join("")
}

// ---- gh pr status ----

const STATUS_SPECS = [bool("conflict-status", "c"), ...JSON_FLAGS]

/** `text.Truncate` for display widths (wide characters count two). */
const truncate = (max: number, text: string): string => {
  const width = (c: string) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u.test(c) ? 2 : 1)
  const chars = [...text]
  if (chars.reduce((sum, c) => sum + width(c), 0) <= max) return text
  const tail = max >= 5 ? "..." : ""
  let out = ""
  let used = 0
  for (const c of chars) {
    if (used + width(c) > max - tail.length) break
    out += c
    used += width(c)
  }
  out += tail
  return used + tail.length < max ? `${out} ` : out
}

/** `PullRequest.ChecksStatus`. */
const checksStatus = (pr: Raw) => {
  const summary = { pending: 0, failing: 0, passing: 0, total: 0 }
  const [last] = nodes(pr.statusCheckRollup)
  if (last === undefined) return summary
  const contexts = obj(obj(obj(last.commit).statusCheckRollup).contexts)
  const runCounts = arr(contexts.checkRunCountsByState).map(obj)
  const statusCounts = arr(contexts.statusContextCountsByState).map(obj)
  if (runCounts.length !== 0 && statusCounts.length !== 0) {
    summary.total = n(contexts.checkRunCount) + n(contexts.statusContextCount)
    for (const c of runCounts) {
      const state = s(c.state)
      if (["NEUTRAL", "SKIPPED", "SUCCESS"].includes(state)) summary.passing += n(c.count)
      else if (["ACTION_REQUIRED", "CANCELLED", "FAILURE", "TIMED_OUT"].includes(state)) summary.failing += n(c.count)
      else summary.pending += n(c.count)
    }
    for (const c of statusCounts) {
      const state = s(c.state)
      if (state === "SUCCESS") summary.passing += n(c.count)
      else if (state === "FAILURE" || state === "ERROR") summary.failing += n(c.count)
      else summary.pending += n(c.count)
    }
    return summary
  }
  for (const c of nodes(contexts)) {
    if (s(c.__typename) === "CheckRun") {
      if (s(c.status) === "COMPLETED") {
        const conclusion = s(c.conclusion)
        if (["NEUTRAL", "SKIPPED", "SUCCESS"].includes(conclusion)) summary.passing++
        else if (["ACTION_REQUIRED", "CANCELLED", "FAILURE", "TIMED_OUT"].includes(conclusion)) summary.failing++
        else summary.pending++
      } else summary.pending++
    } else {
      const state = s(c.state)
      if (state === "SUCCESS") summary.passing++
      else if (state === "FAILURE" || state === "ERROR") summary.failing++
      else summary.pending++
    }
    summary.total++
  }
  return summary
}

const printPrs = (totalCount: number, prs: ReadonlyArray<Raw>): string => {
  let out = ""
  for (const pr of prs) {
    out += `  #${n(pr.number)}  ${truncate(50, squashWhitespace(s(pr.title)))} [${headLabel(pr)}]`
    if (s(pr.state) === "OPEN") {
      const checks = checksStatus(pr)
      const decision = s(pr.reviewDecision)
      const reviewStatus = decision === "CHANGES_REQUESTED" || decision === "APPROVED" || decision === "REVIEW_REQUIRED"
      if (checks.total > 0 || reviewStatus) out += "\n  "
      if (checks.total > 0) {
        let summary = "No checks"
        if (checks.failing > 0) summary = checks.failing === checks.total ? "× All checks failing" : `× ${checks.failing}/${checks.total} checks failing`
        else if (checks.pending > 0) summary = "- Checks pending"
        else if (checks.passing === checks.total) summary = "✓ Checks passing"
        out += summary
      }
      if (checks.total > 0 && reviewStatus) out += " "
      if (decision === "CHANGES_REQUESTED") out += "+ Changes requested"
      else if (decision === "REVIEW_REQUIRED") out += "- Review required"
      else if (decision === "APPROVED") {
        const required = n(obj(obj(obj(pr.baseRef).branchProtectionRule)).requiredApprovingReviewCount)
        const got = nodes(pr.latestReviews).filter((r) => s(r.state) === "APPROVED").length
        out += `✓ ${required > 0 ? `${got}/${required}` : `${got}`} Approved`
      }
      const mergeable = s(pr.mergeable)
      if (mergeable === "MERGEABLE") out += " ✓ No merge conflicts"
      else if (mergeable === "CONFLICTING") out += " × Merge conflicts"
      else if (mergeable === "UNKNOWN") out += " ! Merge conflict status unknown"
      if (b(obj(obj(pr.baseRef).branchProtectionRule).requiresStrictStatusChecks)) {
        const status = s(pr.mergeStateStatus)
        if (status === "BEHIND") out += " - Not up to date"
        else if (status !== "UNKNOWN" && status !== "DIRTY") out += " ✓ Up to date"
      }
      if (objOrNull(pr.autoMergeRequest) !== null) out += " ✓ Auto-merge enabled"
    } else {
      out += ` - ${b(pr.isDraft) && s(pr.state) === "OPEN" ? "Draft" : title(s(pr.state))}`
    }
    out += "\n"
  }
  if (totalCount - prs.length > 0) out += `  And ${totalCount - prs.length} more\n`
  return out
}

const status = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "status", argv, STATUS_SPECS, PULL_REQUEST_FIELDS)
  if (parsed === null) return
  const { f } = parsed
  noArgs("status", parsed, STATUS_SPECS)
  const json = jsonOptions(f, PULL_REQUEST_FIELDS)
  const override = f.changed("repo")
  const repo = await resolveRepo(run, f.string("repo"))

  const checkout = repo.checkout.checkout
  const currentBranch = override ? "" : checkout.branch
  const currentNumber = override ? 0 : (checkout.pullRequest?.number ?? 0)
  const currentHeadRef = override || currentNumber > 0 ? "" : checkout.branch

  let fragments: string
  if (json !== null) {
    const fields = new Set([...json.fields, "isCrossRepository", "headRepositoryOwner", "headRefName"])
    fragments = `fragment pr on PullRequest{${pullRequestGraphQL(fields)}}fragment prWithReviews on PullRequest{...pr}`
  } else {
    const fields = ["number", "title", "state", "url", "isDraft", "isCrossRepository", "headRefName", "headRepositoryOwner", "mergeStateStatus", "requiresStrictStatusChecks", "autoMergeRequest"]
    if (f.bool("conflict-status")) fields.push("mergeable")
    fields.push("statusCheckRollupWithCountByState")
    fragments = `
	fragment pr on PullRequest {${pullRequestGraphQL(fields)}}
	fragment prWithReviews on PullRequest {...pr,${pullRequestGraphQL(["reviewDecision", "latestReviews"])}}
	`
  }
  const prefix =
    currentNumber > 0
      ? `
		query PullRequestStatus($owner: String!, $repo: String!, $number: Int!, $viewerQuery: String!, $reviewerQuery: String!, $per_page: Int = 10) {
			repository(owner: $owner, name: $repo) {
				defaultBranchRef {
					name
				}
				pullRequest(number: $number) {
					...prWithReviews
					baseRef {
						branchProtectionRule {
							requiredApprovingReviewCount
						}
					}
				}
			}
		`
      : `
	query PullRequestStatus($owner: String!, $repo: String!, $headRefName: String!, $viewerQuery: String!, $reviewerQuery: String!, $per_page: Int = 10) {
		repository(owner: $owner, name: $repo) {
			defaultBranchRef {
				name
			}
			pullRequests(headRefName: $headRefName, first: $per_page, orderBy: { field: CREATED_AT, direction: DESC }) {
				totalCount
				edges {
					node {
						...prWithReviews
					}
				}
			}
		}
	`
  const query = `${fragments}${prefix}
			viewerCreated: search(query: $viewerQuery, type: ISSUE, first: $per_page) {
				totalCount: issueCount
				edges {
					node {
					...prWithReviews
					}
				}
			}
			reviewRequested: search(query: $reviewerQuery, type: ISSUE, first: $per_page) {
				totalCount: issueCount
				edges {
					node {
					...pr
					}
				}
			}
		}
	`
  const data = await graphql(run, repo, query, {
    viewerQuery: `repo:${fullName(repo)} state:open is:pr author:@me`,
    reviewerQuery: `repo:${fullName(repo)} state:open review-requested:@me`,
    owner: repo.owner,
    repo: repo.name,
    ...(currentNumber > 0 ? { number: currentNumber } : { headRefName: currentHeadRef }),
  })
  const repository = obj(data.repository)
  const edgeNodes = (v: unknown) => arr(obj(v).edges).map((e) => obj(obj(e).node))
  const viewerCreated = edgeNodes(data.viewerCreated)
  const reviewRequested = edgeNodes(data.reviewRequested)
  let current = objOrNull(repository.pullRequest)
  if (current === null) current = edgeNodes(repository.pullRequests).find((pr) => headLabel(pr) === currentHeadRef) ?? null

  if (json !== null) {
    const exportAll = (prs: ReadonlyArray<Raw>) => prs.map((pr) => exportPullRequest(pr, json.fields))
    return writeJson(
      run,
      // The exporter drops nil map values, so a missing current pull request leaves no key at all.
      {
        createdBy: exportAll(viewerCreated),
        ...(current === null ? {} : { currentBranch: exportPullRequest(current, json.fields) }),
        needsReview: exportAll(reviewRequested),
      },
      json,
    )
  }

  let out = `\nRelevant pull requests in ${fullName(repo)}\n\n`
  if (!override) {
    out += "Current branch\n"
    if (current !== null && s(current.state) !== "OPEN" && s(obj(repository.defaultBranchRef).name) === currentBranch) current = null
    if (current !== null) out += printPrs(1, [current])
    else if (currentHeadRef === "") out += "  There is no current branch\n"
    else out += `  There is no pull request associated with [${currentHeadRef}]\n`
    out += "\n"
  }
  out += "Created by you\n"
  const createdTotal = n(obj(data.viewerCreated).totalCount)
  out += createdTotal > 0 ? printPrs(createdTotal, viewerCreated) : "  You have no open pull requests\n"
  out += "\nRequesting a code review from you\n"
  const requestedTotal = n(obj(data.reviewRequested).totalCount)
  out += requestedTotal > 0 ? printPrs(requestedTotal, reviewRequested) : "  You have no pull requests to review\n"
  out += "\n"
  run.stdout += out
}

// ---- gh pr diff ----

const DIFF_SPECS = [oneOf("color", undefined, ["always", "never", "auto"]), bool("patch"), bool("name-only"), bool("web", "w")]

const colorDiff = (diff: string): string => {
  const lines = diff.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
    .map((raw) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      const header = ["+++", "---", "diff", "index"].some((p) => line.startsWith(p))
      const color = header ? "\x1b[1;38m" : line.startsWith("+") ? "\x1b[32m" : line.startsWith("-") ? "\x1b[31m" : ""
      return color === "" ? `${line}\n` : `${color}${line}\x1b[m\n`
    })
    .join("")
}

const diff = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "diff", argv, DIFF_SPECS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  if (f.string("repo") !== "" && args.length === 0) throw flagError("diff", "argument required when using the `--repo` flag")
  if (f.bool("web")) throw noBrowser()
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["number"] })
  const nameOnly = f.bool("name-only")
  let text: string
  try {
    text = await run.backend.pullRequestDiff(repo.checkout.checkout.id, n(pr.number), f.bool("patch") && !nameOnly ? "patch" : "diff")
  } catch (error) {
    throw new CommandError(`could not find pull request diff: ${errorMessage(error)}`)
  }
  if (nameOnly) {
    for (const match of text.matchAll(/(?:^|\n)diff\s--git.*\s(["]?)b\/(.*)/g)) run.stdout += `${`${match[1] ?? ""}${match[2] ?? ""}`.trim()}\n`
    return
  }
  run.stdout += f.string("color", "auto") === "always" ? colorDiff(text) : text
}

// ---- gh pr create ----

const CREATE_SPECS = [
  bool("draft", "d"),
  str("title", "t"),
  str("body", "b"),
  str("body-file", "F"),
  str("base", "B"),
  str("head", "H"),
  bool("editor", "e"),
  bool("web", "w"),
  bool("fill-verbose"),
  bool("fill", "f"),
  bool("fill-first"),
  slice("reviewer", "r"),
  slice("assignee", "a"),
  slice("label", "l"),
  slice("project", "p"),
  str("milestone", "m"),
  bool("no-maintainer-edit"),
  str("recover"),
  str("template", "T"),
  bool("dry-run"),
]

interface Commit {
  readonly title: string
  readonly body: string
}

/** `git.Client.Commits` over the checkout's own commits, newest first. */
const parseCommitLog = (log: string): Commit[] =>
  [...log.matchAll(/^[0-9a-fA-F]{7,40}\x00.*?\x00[\s\S]*?\x00$/gm)].map((match) => {
    const parts = match[0].split("\x00")
    return { title: parts[1] ?? "", body: parts[2] ?? "" }
  })

const create = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "create", argv, CREATE_SPECS)
  if (parsed === null) return
  const { f } = parsed
  noArgs("create", parsed, CREATE_SPECS)
  const web = f.bool("web")
  if (f.string("recover") !== "") throw flagError("create", "`--recover` only supported when running interactively")
  if (f.bool("draft") && web) throw flagError("create", "the `--draft` flag is not supported with `--web`")
  if (f.slice("reviewer").length > 0 && web) throw flagError("create", "the `--reviewer` flag is not supported with `--web`")
  if (f.changed("no-maintainer-edit") && web) throw flagError("create", "the `--no-maintainer-edit` flag is not supported with `--web`")
  const fill = f.bool("fill")
  const fillFirst = f.bool("fill-first")
  const fillVerbose = f.bool("fill-verbose")
  if (fill && fillFirst) throw flagError("create", "`--fill` is not supported with `--fill-first`")
  if (fillVerbose && fillFirst) throw flagError("create", "`--fill-verbose` is not supported with `--fill-first`")
  if (fillVerbose && fill) throw flagError("create", "`--fill-verbose` is not supported with `--fill`")
  if (f.bool("editor") && web) throw flagError("create", "specify only one of `--editor` or `--web`")
  let body = f.string("body")
  let bodyProvided = f.changed("body")
  if (f.string("body-file") !== "") {
    body = readBodyFile(run, f.string("body-file"))
    bodyProvided = true
  }
  if (f.string("template") !== "" && bodyProvided) throw flagError("create", "`--template` is not supported when using `--body` or `--body-file`")
  const titleProvided = f.changed("title")
  if (!web && !(fillVerbose || fill || fillFirst) && (!titleProvided || !bodyProvided)) {
    throw flagError("create", "must provide `--title` and `--body` (or `--fill` or `fill-first` or `--fillverbose`) when not running interactively")
  }
  if (f.bool("dry-run") && web) throw flagError("create", "`--dry-run` is not supported when using `--web`")
  if (web) throw noBrowser()
  if (f.bool("editor")) throw new CommandError("--editor is not available in Kestrel: pass --title and --body (or --fill)")
  for (const [flag, what] of [
    ["assignee", "assignees"],
    ["project", "projects"],
    ["milestone", "milestones"],
    ["template", "templates"],
    ["no-maintainer-edit", "maintainer edit settings"],
  ] as const) {
    if (f.changed(flag)) throw new CommandError(`--${flag} is not available in Kestrel's gh: ${what} cannot be set from a thread`)
  }

  const repo = await resolveRepo(run, f.string("repo"))
  const checkout = repo.checkout.checkout
  const headFlag = f.string("head")
  if (headFlag !== "") {
    const colon = headFlag.indexOf(":")
    const owner = colon === -1 ? repo.owner : headFlag.slice(0, colon)
    const branch = colon === -1 ? headFlag : headFlag.slice(colon + 1)
    if (owner.toLowerCase() !== repo.owner.toLowerCase() || branch !== checkout.branch) {
      throw new CommandError(`gh in Kestrel opens pull requests from the checkout's branch (${checkout.branch}); --head cannot name another`)
    }
  }
  const head = checkout.branch
  const base = f.string("base") || checkout.baseBranch
  if (head === base) throw new CommandError(`head branch ${quote(head)} is the same as base branch ${quote(base)}, cannot create a pull request`)

  let state = { title: "", body: "" }
  if (fill || fillFirst || fillVerbose) {
    const commits = parseCommitLog(await run.backend.commitLog(checkout.id))
    if (commits.length === 0) {
      throw new CommandError(`could not compute title or body defaults: could not find any commits between origin/${base} and ${head}`)
    }
    if (commits.length === 1 || fillFirst) {
      const first = commits[commits.length - 1] as Commit
      state = { title: first.title, body: first.body }
    } else {
      let text = ""
      for (let i = commits.length - 1; i >= 0; i--) {
        const commit = commits[i] as Commit
        text += `- **${commit.title}**\n`
        if (fillVerbose) {
          text += commit.body.replace(/^/gm, "  ")
          if (i > 0) text += "\n\n"
        }
      }
      state = { title: head.replace(/[_-]/g, " "), body: text }
    }
  }
  if (titleProvided) state.title = f.string("title")
  if (bodyProvided) state.body = body

  try {
    const existing = await findPullRequest(run, f.string("repo"), { selector: head, baseBranch: base, states: ["OPEN"], fields: ["url"] })
    throw new CommandError(`a pull request for branch ${quote(head)} into branch ${quote(base)} already exists:\n${s(existing.pr.url)}`)
  } catch (error) {
    if (error instanceof NotFoundError) {
      // No open pull request yet: create one.
    } else if (error instanceof CommandError && error.message.startsWith("a pull request for branch")) {
      throw error
    } else {
      throw new CommandError(`error checking for existing pull request: ${errorMessage(error)}`)
    }
  }

  if (state.title === "") throw new CommandError("pull request title must not be blank")
  const draft = f.bool("draft")
  if (f.bool("dry-run")) {
    let out = `Would have created a Pull Request with:\ntitle:\t${state.title}\ndraft:\t${draft}\nbase:\t${base}\nhead:\t${head}\n`
    if (f.slice("label").length > 0) out += `labels:\t${f.slice("label").join(", ")}\n`
    if (f.slice("reviewer").length > 0) out += `reviewers:\t${f.slice("reviewer").join(", ")}\n`
    out += `maintainerCanModify:\ttrue\nbody:\n${state.body === "" ? "" : `${state.body}\n`}`
    run.stdout += out
    return
  }

  let opened
  try {
    opened = await run.backend.openPullRequest({ title: state.title, body: state.body, draft, checkoutId: checkout.id, base })
  } catch (error) {
    throw new CommandError(`pull request create failed: ${errorMessage(error)}`)
  }
  if (!opened.created) {
    throw new CommandError(`a pull request for branch ${quote(head)} into branch ${quote(opened.pullRequest.baseRef)} already exists:\n${opened.pullRequest.url}`)
  }
  run.stdout += `${opened.pullRequest.url}\n`
  const target = { checkoutId: checkout.id, number: opened.pullRequest.number }
  try {
    if (f.slice("label").length > 0) await run.backend.changeLabels({ ...target, action: "add", labels: f.slice("label") })
    if (f.slice("reviewer").length > 0) await run.backend.changeReviewers({ ...target, action: "add", ...reviewerRequest(f.slice("reviewer")) })
  } catch (error) {
    throw new CommandError(`pull request update failed: ${errorMessage(error)}`)
  }
}

// ---- gh pr edit ----

const EDIT_SPECS = [
  str("title", "t"),
  str("body", "b"),
  str("body-file", "F"),
  str("base", "B"),
  slice("add-reviewer"),
  slice("remove-reviewer"),
  slice("add-assignee"),
  slice("remove-assignee"),
  slice("add-label"),
  slice("remove-label"),
  slice("add-project"),
  slice("remove-project"),
  str("milestone", "m"),
  bool("remove-milestone"),
]

const edit = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "edit", argv, EDIT_SPECS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  const bodyFile = f.string("body-file")
  if (f.changed("body") && bodyFile !== "") throw flagError("edit", "specify only one of `--body` or `--body-file`")
  let body: string | undefined = f.changed("body") ? f.string("body") : undefined
  if (bodyFile !== "") body = readBodyFile(run, bodyFile)
  if (f.changed("milestone") && f.bool("remove-milestone")) throw flagError("edit", "specify only one of `--milestone` or `--remove-milestone`")
  const changed = (...names: string[]) => names.some((name) => f.changed(name))
  const dirty =
    changed("title", "body", "base", "add-reviewer", "remove-reviewer", "add-assignee", "remove-assignee", "add-label", "remove-label", "add-project", "remove-project", "milestone") ||
    body !== undefined ||
    f.bool("remove-milestone")
  if (!dirty) throw flagError("edit", "--title, --body, --reviewer, --assignee, --label, --project, or --milestone required when not running interactively")
  if (changed("add-assignee", "remove-assignee")) throw new CommandError("--add-assignee and --remove-assignee are not available in Kestrel's gh")
  if (changed("add-project", "remove-project")) throw new CommandError("--add-project and --remove-project are not available in Kestrel's gh")
  if (changed("milestone", "remove-milestone")) throw new CommandError("--milestone and --remove-milestone are not available in Kestrel's gh")

  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["id", "url", "title", "body", "baseRefName"] })
  const target = { checkoutId: repo.checkout.checkout.id, number: n(pr.number) }
  const titleValue = f.changed("title") ? f.string("title") : undefined
  const base = f.changed("base") ? f.string("base") : undefined
  if (titleValue !== undefined || body !== undefined || base !== undefined) {
    await run.backend.updatePullRequest({ ...target, title: titleValue, body, base })
  }
  if (f.slice("add-reviewer").length > 0) await run.backend.changeReviewers({ ...target, action: "add", ...reviewerRequest(f.slice("add-reviewer")) })
  if (f.slice("remove-reviewer").length > 0) await run.backend.changeReviewers({ ...target, action: "remove", ...reviewerRequest(f.slice("remove-reviewer")) })
  if (f.slice("add-label").length > 0) await run.backend.changeLabels({ ...target, action: "add", labels: f.slice("add-label") })
  if (f.slice("remove-label").length > 0) await run.backend.changeLabels({ ...target, action: "remove", labels: f.slice("remove-label") })
  run.stdout += `${s(pr.url)}\n`
}

// ---- gh pr ready ----

const ready = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "ready", argv, [bool("undo")])
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  if (f.string("repo") !== "" && args.length === 0) throw flagError("ready", "argument required when using the --repo flag")
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["id", "number", "state", "isDraft"] })
  const ref = `${fullName(repo)}#${n(pr.number)}`
  if (s(pr.state) !== "OPEN") {
    run.stderr += `X Pull request ${ref} is closed. Only draft pull requests can be marked as "ready for review"\n`
    throw new SilentExit(1)
  }
  const target = { checkoutId: repo.checkout.checkout.id, number: n(pr.number) }
  if (f.bool("undo")) {
    if (b(pr.isDraft)) {
      run.stderr += `! Pull request ${ref} is already "in draft"\n`
      return
    }
    await run.backend.updatePullRequest({ ...target, draft: true }).catch((error: unknown) => Promise.reject(apiFailed(error)))
    run.stderr += `✓ Pull request ${ref} is converted to "draft"\n`
    return
  }
  if (!b(pr.isDraft)) {
    run.stderr += `! Pull request ${ref} is already "ready for review"\n`
    return
  }
  await run.backend.updatePullRequest({ ...target, draft: false }).catch((error: unknown) => Promise.reject(apiFailed(error)))
  run.stderr += `✓ Pull request ${ref} is marked as "ready for review"\n`
}

// ---- gh pr close / reopen ----

const closeOrReopen = (command: "close" | "reopen") => async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, command, argv, command === "close" ? [str("comment", "c"), bool("delete-branch", "d")] : [str("comment", "c")])
  if (parsed === null) return
  const { f, args } = parsed
  if (command === "close") {
    if (args.length > 1) throw flagError("close", "too many arguments")
    if (args.length < 1) throw flagError("close", "cannot close pull request: number, url, or branch required")
  } else if (args.length !== 1) {
    throw new CommandError(`accepts 1 arg(s), received ${args.length}`)
  }
  if (command === "close" && f.bool("delete-branch")) {
    throw new CommandError("--delete-branch is not available in Kestrel's gh: branches are left for the thread owner to delete")
  }
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] as string, fields: ["id", "number", "state", "title"] })
  const label = `${fullName(repo)}#${n(pr.number)} (${s(pr.title)})`
  if (s(pr.state) === "MERGED") {
    run.stderr += `X Pull request ${label} can't be ${command === "close" ? "closed" : "reopened"} because it was already merged\n`
    throw new SilentExit(1)
  }
  if (command === "close" && s(pr.state) !== "OPEN") {
    run.stderr += `! Pull request ${label} is already closed\n`
    return
  }
  if (command === "reopen" && s(pr.state) === "OPEN") {
    run.stderr += `! Pull request ${label} is already open\n`
    return
  }
  const target = { checkoutId: repo.checkout.checkout.id, number: n(pr.number) }
  if (f.string("comment") !== "") await run.backend.comment({ ...target, body: f.string("comment") })
  await run.backend
    .updatePullRequest({ ...target, state: command === "close" ? "closed" : "open" })
    .catch((error: unknown) => Promise.reject(apiFailed(error)))
  run.stderr += command === "close" ? `✓ Closed pull request ${label}\n` : `✓ Reopened pull request ${label}\n`
}

// ---- gh pr comment ----

const COMMENT_SPECS = [str("body", "b"), str("body-file", "F"), bool("editor", "e"), bool("web", "w"), bool("edit-last"), bool("delete-last"), bool("yes"), bool("create-if-none")]

const comment = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "comment", argv, COMMENT_SPECS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  if (f.string("repo") !== "" && args.length === 0) throw flagError("comment", "argument required when using the --repo flag")
  const inputs = [f.changed("body"), f.changed("body-file"), f.bool("web"), f.bool("editor")].filter(Boolean).length
  if (f.bool("create-if-none") && !f.bool("edit-last")) throw flagError("comment", "`--create-if-none` can only be used with `--edit-last`")
  if (f.bool("yes") && !f.bool("delete-last")) throw flagError("comment", "`--yes` should only be used with `--delete-last`")
  if (f.bool("delete-last")) {
    if (inputs > 0) throw flagError("comment", "should not provide comment body when using `--delete-last`")
    if (!f.bool("yes")) throw flagError("comment", "should provide `--yes` to confirm deletion in non-interactive mode")
  } else if (inputs === 0) {
    throw flagError("comment", "flags required when not running interactively")
  } else if (inputs > 1) {
    throw flagError("comment", "specify only one of `--body`, `--body-file`, `--editor`, or `--web`")
  }
  if (f.bool("edit-last") || f.bool("delete-last")) {
    throw new CommandError("--edit-last and --delete-last are not available in Kestrel's gh; use the github_pr_comment tool to edit or delete a comment")
  }
  if (f.bool("web")) throw noBrowser()
  if (f.bool("editor")) throw new CommandError("--editor is not available in Kestrel: pass --body or --body-file")
  const body = f.string("body-file") !== "" ? readBodyFile(run, f.string("body-file")) : f.string("body")
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["id", "url"] })
  const posted = await run.backend.comment({ checkoutId: repo.checkout.checkout.id, number: n(pr.number), body })
  run.stdout += `${posted.url}\n`
}

// ---- gh pr review ----

const REVIEW_SPECS = [bool("approve", "a"), bool("request-changes", "r"), bool("comment", "c"), str("body", "b"), str("body-file", "F")]

const review = async (run: GhRun, argv: ReadonlyArray<string>): Promise<void> => {
  const parsed = parse(run, "review", argv, REVIEW_SPECS)
  if (parsed === null) return
  const { f, args } = parsed
  maxArgs(args, 1)
  if (f.string("repo") !== "" && args.length === 0) throw flagError("review", "argument required when using the --repo flag")
  const bodyFile = f.string("body-file")
  if (f.changed("body") && bodyFile !== "") throw flagError("review", "specify only one of `--body` or `--body-file`")
  const body = bodyFile !== "" ? readBodyFile(run, bodyFile) : f.string("body")
  let found = 0
  let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT"
  if (f.bool("approve")) {
    found++
    event = "APPROVE"
  }
  if (f.bool("request-changes")) {
    found++
    event = "REQUEST_CHANGES"
    if (body === "") throw flagError("review", "body cannot be blank for request-changes review")
  }
  if (f.bool("comment")) {
    found++
    event = "COMMENT"
    if (body === "") throw flagError("review", "body cannot be blank for comment review")
  }
  if (found === 0 && body === "") throw flagError("review", "--approve, --request-changes, or --comment required when not running interactively")
  if (found === 0) throw flagError("review", "--body unsupported without --approve, --request-changes, or --comment")
  if (found > 1) throw flagError("review", "need exactly one of --approve, --request-changes, or --comment")
  if (event === "APPROVE") {
    throw new CommandError("approving pull requests is turned off in Kestrel: an agent's approval would count as the thread owner's; use --comment or --request-changes")
  }
  const { pr, repo } = await findPullRequest(run, f.string("repo"), { selector: args[0] ?? "", fields: ["id", "number"] })
  try {
    await run.backend.review({ checkoutId: repo.checkout.checkout.id, number: n(pr.number), body, event, comments: [] })
  } catch (error) {
    throw new CommandError(`failed to create review: ${errorMessage(error)}`)
  }
}

// ---- dispatch ----

export const PR_COMMANDS: Readonly<Record<string, (run: GhRun, argv: ReadonlyArray<string>) => Promise<void>>> = {
  checks,
  close: closeOrReopen("close"),
  comment,
  create,
  new: create,
  diff,
  edit,
  list,
  ls: list,
  ready,
  reopen: closeOrReopen("reopen"),
  review,
  status,
  view,
}

/** `gh pr` subcommands the real CLI has and Kestrel's does not. */
export const PR_UNAVAILABLE = ["checkout", "lock", "merge", "revert", "unlock", "update-branch"]

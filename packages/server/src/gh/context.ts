import { relative, resolve as resolvePath, isAbsolute } from "node:path"
import type { GhCheckout, LabelChange, OpenedPullRequest, OpenPullRequestInput, PullRequestTarget, ReviewerChange } from "../core/service"
import type { GraphQLResponse, NewReview, PostedComment, PostedReview, PullRequest, PullRequestChanges } from "../github/api"
import { b, nodes, obj, pullRequestGraphQL, s, statusCheckRollupFields } from "./fields"

type Raw = Record<string, unknown>

/**
 * What the `gh` shim may do for one agent run, bound to its thread. Every GitHub call goes through the box with the
 * thread owner's token; failures reject with an Error whose message is shown to the agent.
 */
export interface GhBackend {
  readonly checkouts: () => Promise<ReadonlyArray<GhCheckout>>
  readonly graphql: (checkoutId: string, query: string, variables: Readonly<Record<string, unknown>>) => Promise<GraphQLResponse>
  readonly pullRequestDiff: (checkoutId: string, number: number, format: "diff" | "patch") => Promise<string>
  readonly commitLog: (checkoutId: string) => Promise<string>
  readonly openPullRequest: (input: OpenPullRequestInput) => Promise<OpenedPullRequest>
  readonly updatePullRequest: (input: PullRequestTarget & PullRequestChanges) => Promise<PullRequest>
  readonly comment: (input: PullRequestTarget & { readonly body: string }) => Promise<PostedComment>
  readonly review: (input: NewReview & { readonly number: number; readonly checkoutId: string }) => Promise<PostedReview>
  readonly changeReviewers: (input: PullRequestTarget & ReviewerChange) => Promise<void>
  readonly changeLabels: (input: PullRequestTarget & LabelChange) => Promise<void>
}

/** A command failure: the message goes to stderr, followed by the command's usage for flag errors. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly usage: string | null = null,
  ) {
    super(message)
  }
}

/** Ends the command with `code` and nothing more on stderr (the CLI's SilentError and PendingError). */
export class SilentExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

export interface GhRun {
  readonly backend: GhBackend
  /** The agent's working directory. */
  readonly cwd: string
  /**
   * Files the shim read inside the sandbox for `--body-file`, by the path given (`-` is standard input); null when
   * the shim could not read it.
   */
  readonly files: ReadonlyMap<string, string | null>
  /** Aborted when the shim hangs up. */
  readonly signal: AbortSignal
  stdout: string
  stderr: string
}

/** The repository a command works on: a checkout of the thread on github.com. */
export interface RepoTarget {
  readonly checkout: GhCheckout
  readonly owner: string
  readonly name: string
}

export const fullName = (repo: RepoTarget): string => `${repo.owner}/${repo.name}`

/** `GraphQLError.Error()` of go-gh. */
const graphQLMessage = (errors: GraphQLResponse["errors"]): string =>
  `GraphQL: ${errors.map((e) => (e.path === undefined || e.path.length === 0 ? e.message : `${e.message} (${e.path.join(".")})`)).join(", ")}`

/** Runs a GraphQL document for the repository; any GraphQL error fails the command, as in the CLI. */
export const graphql = async (run: GhRun, repo: RepoTarget, query: string, variables: Readonly<Record<string, unknown>>): Promise<Raw> => {
  const response = await run.backend.graphql(repo.checkout.checkout.id, query, variables)
  if (response.errors.length > 0) throw new CommandError(graphQLMessage(response.errors))
  return obj(response.data)
}

/** Parses `[HOST/]OWNER/REPO` or a repository URL the way `ghrepo.FromFullName` does. */
const parseRepoArg = (value: string): { readonly host: string; readonly owner: string; readonly name: string } | null => {
  let text = value
  if (/^https?:\/\//.test(text) || text.startsWith("git@") || text.startsWith("ssh://")) {
    const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(text)
    return match ? { host: match[1] as string, owner: match[2] as string, name: match[3] as string } : null
  }
  text = text.replace(/\/+$/, "")
  const parts = text.split("/")
  if (parts.some((p) => p === "")) return null
  if (parts.length === 2) return { host: "github.com", owner: parts[0] as string, name: parts[1] as string }
  if (parts.length === 3) return { host: parts[0] as string, owner: parts[1] as string, name: parts[2] as string }
  return null
}

const insideDir = (dir: string, path: string): boolean => {
  const rel = relative(resolvePath(dir), resolvePath(path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const githubTarget = (checkout: GhCheckout): RepoTarget => {
  if (checkout.github === null) {
    throw new CommandError(`${checkout.checkout.repo} is not a github.com repository; gh only works with GitHub repositories`)
  }
  return { checkout, owner: checkout.github.owner, name: checkout.github.name }
}

/**
 * The repository `-R` names, else the checkout the working directory is in, else the thread's only GitHub checkout.
 * Repositories outside the thread are refused: gh here acts only on what the thread has checked out.
 */
export const resolveRepo = async (run: GhRun, repoFlag: string): Promise<RepoTarget> => {
  const checkouts = await run.backend.checkouts()
  if (repoFlag !== "") {
    const parsed = parseRepoArg(repoFlag)
    if (parsed === null) throw new CommandError(`expected the "[HOST/]OWNER/REPO" format, got "${repoFlag}"`)
    if (parsed.host.toLowerCase() !== "github.com") {
      throw new CommandError(`${parsed.host} is not supported: gh in Kestrel works with github.com repositories only`)
    }
    return byName(checkouts, parsed.owner, parsed.name)
  }
  const containing = checkouts
    .filter((c) => insideDir(c.dir, run.cwd))
    .sort((x, y) => y.dir.length - x.dir.length)[0]
  if (containing !== undefined) return githubTarget(containing)
  const github = checkouts.filter((c) => c.github !== null)
  if (github.length === 1) return githubTarget(github[0] as GhCheckout)
  if (github.length === 0) {
    throw new CommandError("this thread has no GitHub checkout; check a repository out with repo_checkout first")
  }
  throw new CommandError(
    `could not tell which checkout to use: run gh inside one of ${github.map((c) => c.dir).join(", ")}, or pass -R OWNER/REPO`,
  )
}

const byName = (checkouts: ReadonlyArray<GhCheckout>, owner: string, name: string): RepoTarget => {
  const found = checkouts.find(
    (c) => c.github !== null && c.github.owner.toLowerCase() === owner.toLowerCase() && c.github.name.toLowerCase() === name.toLowerCase(),
  )
  if (found === undefined) {
    throw new CommandError(
      `${owner}/${name} is not checked out in this thread; gh in Kestrel works on the thread's checkouts (check it out with repo_checkout first)`,
    )
  }
  return githubTarget(found)
}

/** `shared.ParseURL`: a pull request URL's repository and number. */
const parsePullRequestUrl = (value: string): { readonly host: string; readonly owner: string; readonly name: string; readonly number: number } | null => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.pathname)
  if (match === null) return null
  return { host: url.hostname, owner: match[1] as string, name: match[2] as string, number: Number(match[3]) }
}

export class NotFoundError extends CommandError {}

export interface FindOptions {
  readonly selector: string
  readonly fields: ReadonlyArray<string>
  /** Scopes a branch lookup to pull requests into this branch (`gh pr create`). */
  readonly baseBranch?: string
  /** Scopes a branch lookup to these states; all states when absent. */
  readonly states?: ReadonlyArray<string>
}

export interface Found {
  readonly pr: Raw
  readonly repo: RepoTarget
}

/**
 * `shared.Finder.Find`: a URL, a number (`#` optional) or a branch (`OWNER:BRANCH` allowed); no selector means the
 * checkout's own pull request, recorded on it or found by its branch.
 */
export const findPullRequest = async (run: GhRun, repoFlag: string, opts: FindOptions): Promise<Found> => {
  const url = parsePullRequestUrl(opts.selector)
  let repo: RepoTarget
  let number = 0
  if (url !== null) {
    if (url.host.toLowerCase() !== "github.com") {
      throw new CommandError(`${url.host} is not supported: gh in Kestrel works with github.com repositories only`)
    }
    repo = byName(await run.backend.checkouts(), url.owner, url.name)
    number = url.number
  } else {
    repo = await resolveRepo(run, repoFlag)
  }

  let branch = ""
  if (url === null && opts.selector === "") {
    const linked = repo.checkout.checkout.pullRequest
    if (linked !== undefined && opts.baseBranch === undefined) number = linked.number
    else branch = repo.checkout.checkout.branch
  } else if (url === null) {
    const asNumber = /^#?\d+$/.test(opts.selector) ? Number(opts.selector.replace(/^#/, "")) : Number.NaN
    if (opts.baseBranch === undefined && Number.isSafeInteger(asNumber)) number = asNumber
    else branch = opts.selector
  }

  const fields = new Set(opts.fields)
  fields.add("id")
  fields.add("number")

  let pr: Raw
  if (number > 0) {
    if (opts.fields.length === 1 && opts.fields[0] === "number") return { pr: { number }, repo }
    const data = await graphql(
      run,
      repo,
      `
	query PullRequestByNumber($owner: String!, $repo: String!, $pr_number: Int!) {
		repository(owner: $owner, name: $repo) {
			pullRequest(number: $pr_number) {${pullRequestGraphQL(fields)}}
		}
	}`,
      { owner: repo.owner, repo: repo.name, pr_number: number },
    )
    pr = obj(obj(data.repository).pullRequest)
  } else if (branch !== "") {
    pr = await findForBranch(run, repo, branch, opts, fields)
  } else {
    throw new NotFoundError("no pull requests found")
  }

  await preload(run, repo, pr, fields)
  return { pr, repo }
}

/** `findForRefs`: the newest matching pull request whose head is `branch`, open ones first. */
const findForBranch = async (run: GhRun, repo: RepoTarget, branch: string, opts: FindOptions, fields: Set<string>): Promise<Raw> => {
  const colon = branch.indexOf(":")
  const headOwner = colon === -1 ? null : branch.slice(0, colon)
  const headRef = colon === -1 ? branch : branch.slice(colon + 1)
  const qualified = headOwner === null || headOwner.toLowerCase() === repo.owner.toLowerCase() ? headRef : `${headOwner}:${headRef}`
  for (const required of ["state", "baseRefName", "headRefName", "isCrossRepository", "headRepositoryOwner"]) fields.add(required)
  const data = await graphql(
    run,
    repo,
    `
	query PullRequestForBranch($owner: String!, $repo: String!, $headRefName: String!, $states: [PullRequestState!]) {
		repository(owner: $owner, name: $repo) {
			pullRequests(headRefName: $headRefName, states: $states, first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
				nodes {${pullRequestGraphQL(fields)}}
			}
			defaultBranchRef { name }
		}
	}`,
    { owner: repo.owner, repo: repo.name, headRefName: headRef, states: opts.states ?? null },
  )
  const repository = obj(data.repository)
  const defaultBranch = s(obj(repository.defaultBranchRef).name)
  const prs = [...nodes(repository.pullRequests)].sort((x, y) => Number(s(y.state) === "OPEN") - Number(s(x.state) === "OPEN"))
  for (const pr of prs) {
    const label = b(pr.isCrossRepository) ? `${s(obj(pr.headRepositoryOwner).login)}:${s(pr.headRefName)}` : s(pr.headRefName)
    const baseMatches = opts.baseBranch === undefined || s(pr.baseRefName) === opts.baseBranch
    if (label === qualified && baseMatches && (s(pr.state) === "OPEN" || defaultBranch !== qualified)) return pr
  }
  throw new NotFoundError(`no pull requests found for branch "${qualified}"`)
}

/** Pages the lists the first query cut at 100: reviews, comments and status checks (`preloadPr*`). */
const preload = async (run: GhRun, repo: RepoTarget, pr: Raw, fields: ReadonlySet<string>): Promise<void> => {
  const id = s(pr.id)
  for (const list of ["reviews", "comments"] as const) {
    if (!fields.has(list)) continue
    const connection = obj(pr[list])
    let page = obj(connection.pageInfo)
    const all = [...nodes(connection)]
    while (b(page.hasNextPage)) {
      const selection = list === "reviews" ? reviewsPage : commentsPage
      const data = await graphql(run, repo, `query($id: ID!, $endCursor: String) { node(id: $id) { ...on PullRequest { ${selection} } } }`, {
        id,
        endCursor: s(page.endCursor),
      })
      const next = obj(obj(data.node)[list])
      all.push(...nodes(next))
      page = obj(next.pageInfo)
    }
    pr[list] = { ...connection, nodes: all, totalCount: all.length, pageInfo: { hasNextPage: false, endCursor: "" } }
  }
  if (fields.has("statusCheckRollup")) {
    const [last] = nodes(pr.statusCheckRollup)
    if (last === undefined) return
    const contexts = obj(obj(obj(last.commit).statusCheckRollup).contexts)
    let page = obj(contexts.pageInfo)
    const all = [...nodes(contexts)]
    while (b(page.hasNextPage)) {
      const data = await graphql(
        run,
        repo,
        `query($id: ID!, $endCursor: String) { node(id: $id) { ...on PullRequest { ${statusCheckRollupFields("$endCursor")} } } }`,
        { id, endCursor: s(page.endCursor) },
      )
      const [commit] = nodes(obj(data.node).statusCheckRollup)
      const next = obj(obj(obj(obj(commit).commit).statusCheckRollup).contexts)
      all.push(...nodes(next))
      page = obj(next.pageInfo)
    }
    contexts.nodes = all
  }
}

const reviewsPage =
  "reviews(first: 100, after: $endCursor){nodes{id,author{login},authorAssociation,submittedAt,body,state,commit{oid},reactionGroups{content,users{totalCount}}},pageInfo{hasNextPage,endCursor},totalCount}"
const commentsPage =
  "comments(first: 100, after: $endCursor){nodes{id,author{login,...on User{id,name}},authorAssociation,body,createdAt,includesCreatedEdit,isMinimized,minimizedReason,reactionGroups{content,users{totalCount}},url,viewerDidAuthor},pageInfo{hasNextPage,endCursor},totalCount}"

/** Project (v2) items of a pull request; empty when the token cannot read projects, as the CLI tolerates. */
export const loadProjectItems = async (run: GhRun, repo: RepoTarget, number: number): Promise<ReadonlyArray<Raw>> => {
  const response = await run.backend.graphql(
    repo.checkout.checkout.id,
    `query PullRequestProjectItems($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          projectItems(first: 100) {
            nodes { id, project { id, title }, status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId, name } } }
          }
        }
      }
    }`,
    { owner: repo.owner, name: repo.name, number },
  )
  if (response.errors.length > 0) return []
  return nodes(obj(obj(obj(response.data).repository).pullRequest).projectItems)
}

/**
 * Pull request fields as the GitHub CLI (2.87.3) asks GraphQL for them (`api/query_builder.go`) and exports them for
 * `--json` (`api/export_pr.go`). Exported values reproduce Go's encoding: struct fields keep their declaration order,
 * maps (and therefore the top level) are sorted by key, and absent GraphQL values become Go zero values.
 */

type Raw = Record<string, unknown>

const shorten = (q: string): string => q.replace(/[\n\t]/g, "")

const AUTO_MERGE_REQUEST = shorten(`autoMergeRequest {
		authorEmail,
		commitBody,
		commitHeadline,
		mergeMethod,
		enabledAt,
		enabledBy{login,...on User{id,name}}
	}`)

const ISSUE_COMMENTS = shorten(`comments(first: 100) {
		nodes {
			id,
			author{login,...on User{id,name}},
			authorAssociation,
			body,
			createdAt,
			includesCreatedEdit,
			isMinimized,
			minimizedReason,
			reactionGroups{content,users{totalCount}},
			url,
			viewerDidAuthor
		},
		pageInfo{hasNextPage,endCursor},
		totalCount
	}`)

const PR_REVIEW_REQUESTS = shorten(`reviewRequests(first: 100) {
		nodes {
			requestedReviewer {
				__typename,
				...on User{login,name},
				...on Bot{login},
				...on Team{
					organization{login}
					name,
					slug
				}
			}
		}
	}`)

const PR_REVIEWS = shorten(`reviews(first: 100) {
		nodes {
			id,
			author{login},
			authorAssociation,
			submittedAt,
			body,
			state,
			commit{oid},
			reactionGroups{content,users{totalCount}}
		}
		pageInfo{hasNextPage,endCursor}
		totalCount
	}`)

const PR_LATEST_REVIEWS = shorten(`latestReviews(first: 100) {
		nodes {
			author{login},
			authorAssociation,
			submittedAt,
			body,
			state
		}
	}`)

const PR_FILES = shorten(`files(first: 100) {
		nodes {
			additions,
			deletions,
			path
		}
	}`)

const PR_COMMITS = shorten(`commits(first: 100) {
		nodes {
			commit {
				authors(first:100) {
					nodes {
						name,
						email,
						user{id,login}
					}
				},
				messageHeadline,
				messageBody,
				oid,
				committedDate,
				authoredDate
			}
		}
	}`)

const PR_CLOSING_ISSUES = shorten(`closingIssuesReferences(first: 100) {
		nodes {
			id,
			number,
			url,
			repository {
				id,
				name,
				owner {
					id,
					login
				}
			}
		}
		pageInfo{hasNextPage,endCursor}
	}`)

const CHECK_CONTEXT_COUNTS = shorten(`statusCheckRollup: commits(last: 1) {
		nodes {
			commit {
				statusCheckRollup {
					contexts {
						checkRunCount,
						checkRunCountsByState {
							state,
							count
						},
						statusContextCount,
						statusContextCountsByState {
							state,
							count
						}
					}
				}
			}
		}
	}`)

/** The status-check rollup with every context, first page (or the page after `after`). */
export const statusCheckRollupFields = (after: string): string =>
  shorten(`statusCheckRollup: commits(last: 1) {
		nodes {
			commit {
				statusCheckRollup {
					contexts(first:100${after === "" ? "" : `,after:${after}`}) {
						nodes {
							__typename
							...on StatusContext {
								context,
								state,
								targetUrl,
								createdAt,
								description
							},
							...on CheckRun {
								name,
								checkSuite{workflowRun{workflow{name}}},
								status,
								conclusion,
								startedAt,
								completedAt,
								detailsUrl
							}
						},
						pageInfo{hasNextPage,endCursor}
					}
				}
			}
		}
	}`)

/** `gh pr checks`' rollup: every context with whether it is required for `prID`, and the run's event. */
export const requiredStatusCheckRollupFields = (prID: string, after: string): string =>
  shorten(`statusCheckRollup: commits(last: 1) {
		nodes {
			commit {
				statusCheckRollup {
					contexts(first:100${after === "" ? "" : `,after:${after}`}) {
						nodes {
							__typename
							...on StatusContext {
								context,
								state,
								targetUrl,
								createdAt,
								description,
								isRequired(pullRequestId: ${prID})
							},
							...on CheckRun {
								name,
								checkSuite{workflowRun{event,workflow{name}}},
								status,
								conclusion,
								startedAt,
								completedAt,
								detailsUrl,
								isRequired(pullRequestId: ${prID})
							}
						},
						pageInfo{hasNextPage,endCursor}
					}
				}
			}
		}
	}`)

/** Fields `--json` accepts for pull requests, in the GitHub CLI's order. */
export const PULL_REQUEST_FIELDS: ReadonlyArray<string> = [
  "assignees",
  "author",
  "body",
  "closed",
  "comments",
  "createdAt",
  "closedAt",
  "id",
  "labels",
  "milestone",
  "number",
  "projectCards",
  "projectItems",
  "reactionGroups",
  "state",
  "title",
  "updatedAt",
  "url",
  "additions",
  "autoMergeRequest",
  "baseRefName",
  "baseRefOid",
  "changedFiles",
  "closingIssuesReferences",
  "commits",
  "deletions",
  "files",
  "fullDatabaseId",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "isCrossRepository",
  "isDraft",
  "latestReviews",
  "maintainerCanModify",
  "mergeable",
  "mergeCommit",
  "mergedAt",
  "mergedBy",
  "mergeStateStatus",
  "potentialMergeCommit",
  "reviewDecision",
  "reviewRequests",
  "reviews",
  "statusCheckRollup",
]

/**
 * The GraphQL selection for these fields (`PullRequestGraphQL`). `projectCards` and `projectItems` are left out:
 * github.com no longer serves classic projects, and project items need their own query.
 */
export const pullRequestGraphQL = (fields: Iterable<string>): string => {
  const q: string[] = []
  for (const field of fields) {
    switch (field) {
      case "projectCards":
      case "projectItems":
        break
      case "author":
        q.push("author{login,...on User{id,name}}")
        break
      case "mergedBy":
        q.push("mergedBy{login,...on User{id,name}}")
        break
      case "headRepositoryOwner":
        q.push("headRepositoryOwner{id,login,...on User{name}}")
        break
      case "headRepository":
        q.push("headRepository{id,name}")
        break
      case "assignees":
        q.push("assignees(first:100){nodes{id,login,name},totalCount}")
        break
      case "labels":
        q.push("labels(first:100){nodes{id,name,description,color},totalCount}")
        break
      case "milestone":
        q.push("milestone{number,title,description,dueOn}")
        break
      case "reactionGroups":
        q.push("reactionGroups{content,users{totalCount}}")
        break
      case "mergeCommit":
        q.push("mergeCommit{oid}")
        break
      case "potentialMergeCommit":
        q.push("potentialMergeCommit{oid}")
        break
      case "autoMergeRequest":
        q.push(AUTO_MERGE_REQUEST)
        break
      case "comments":
        q.push(ISSUE_COMMENTS)
        break
      case "reviewRequests":
        q.push(PR_REVIEW_REQUESTS)
        break
      case "reviews":
        q.push(PR_REVIEWS)
        break
      case "latestReviews":
        q.push(PR_LATEST_REVIEWS)
        break
      case "files":
        q.push(PR_FILES)
        break
      case "commits":
        q.push(PR_COMMITS)
        break
      case "commitsCount":
        q.push("commits{totalCount}")
        break
      case "requiresStrictStatusChecks":
        q.push("baseRef{branchProtectionRule{requiresStrictStatusChecks}}")
        break
      case "statusCheckRollup":
        q.push(statusCheckRollupFields(""))
        break
      case "statusCheckRollupWithCountByState":
        q.push(CHECK_CONTEXT_COUNTS)
        break
      case "closingIssuesReferences":
        q.push(PR_CLOSING_ISSUES)
        break
      default:
        q.push(field)
    }
  }
  return q.join(",")
}

// ---- reading raw GraphQL values with Go's zero values ----

export const obj = (v: unknown): Raw => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {})
export const objOrNull = (v: unknown): Raw | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null)
export const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])
export const s = (v: unknown): string => (typeof v === "string" ? v : "")
export const n = (v: unknown): number => (typeof v === "number" ? v : 0)
export const b = (v: unknown): boolean => v === true
/** A `time.Time`: GitHub's RFC 3339 text, or Go's zero time when absent. */
export const time = (v: unknown): string => (typeof v === "string" && v !== "" ? v : "0001-01-01T00:00:00Z")
/** A `*time.Time`: null when absent. */
const timePtr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)
export const nodes = (v: unknown): ReadonlyArray<Raw> => arr(obj(v).nodes).map(obj)

/** A Go map, which encoding/json writes with sorted keys. */
export const sortedMap = (entries: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]))

/** `api.Author`'s MarshalJSON: users carry an id; anything else (bots, apps, ghosts) is `app/<login>`. */
export const exportAuthor = (v: unknown): Record<string, unknown> => {
  const a = obj(v)
  return s(a.id) === ""
    ? sortedMap({ is_bot: true, login: `app/${s(a.login)}` })
    : sortedMap({ is_bot: false, login: s(a.login), id: s(a.id), name: s(a.name) })
}

/** `api.ReactionGroups`' MarshalJSON keeps only groups somebody reacted with. */
const exportReactionGroups = (v: unknown): ReadonlyArray<unknown> =>
  arr(v)
    .map(obj)
    .filter((g) => n(obj(g.users).totalCount) !== 0)
    .map((g) => ({ content: s(g.content), users: { totalCount: n(obj(g.users).totalCount) } }))

const exportComment = (c: Raw): Record<string, unknown> => ({
  id: s(c.id),
  author: { login: s(obj(c.author).login) },
  authorAssociation: s(c.authorAssociation),
  body: s(c.body),
  createdAt: time(c.createdAt),
  includesCreatedEdit: b(c.includesCreatedEdit),
  isMinimized: b(c.isMinimized),
  minimizedReason: s(c.minimizedReason),
  reactionGroups: exportReactionGroups(c.reactionGroups),
  ...(s(c.url) === "" ? {} : { url: s(c.url) }),
  viewerDidAuthor: b(c.viewerDidAuthor),
})

const exportReview = (r: Raw): Record<string, unknown> => ({
  id: s(r.id),
  author: { login: s(obj(r.author).login) },
  authorAssociation: s(r.authorAssociation),
  body: s(r.body),
  submittedAt: timePtr(r.submittedAt),
  includesCreatedEdit: b(r.includesCreatedEdit),
  reactionGroups: exportReactionGroups(r.reactionGroups),
  state: s(r.state),
  ...(s(r.url) === "" ? {} : { url: s(r.url) }),
  commit: { oid: s(obj(r.commit).oid) },
})

/** The status-check contexts of the rollup's last commit, or null when the pull request has no commit. */
export const rollupContexts = (pr: Raw): ReadonlyArray<Raw> | null => {
  const [first] = nodes(pr.statusCheckRollup)
  return first === undefined ? null : nodes(obj(obj(obj(first.commit).statusCheckRollup).contexts))
}

const exportStatusCheckRollup = (pr: Raw): ReadonlyArray<unknown> | null => {
  const contexts = rollupContexts(pr)
  if (contexts === null) return null
  return contexts.map((c) =>
    s(c.__typename) === "CheckRun"
      ? sortedMap({
          __typename: "CheckRun",
          name: s(c.name),
          workflowName: s(obj(obj(obj(c.checkSuite).workflowRun).workflow).name),
          status: s(c.status),
          conclusion: s(c.conclusion),
          startedAt: time(c.startedAt),
          completedAt: time(c.completedAt),
          detailsUrl: s(c.detailsUrl),
        })
      : sortedMap({
          __typename: s(c.__typename),
          context: s(c.context),
          state: s(c.state),
          targetUrl: s(c.targetUrl),
          startedAt: time(c.createdAt),
        }),
  )
}

const exportOwnerRepository = (r: Raw) =>
  sortedMap({
    id: s(r.id),
    number: n(r.number),
    url: s(r.url),
    repository: sortedMap({
      id: s(obj(r.repository).id),
      name: s(obj(r.repository).name),
      owner: sortedMap({ id: s(obj(obj(r.repository).owner).id), login: s(obj(obj(r.repository).owner).login) }),
    }),
  })

/** One field of `PullRequest.ExportData`. */
const exportField = (pr: Raw, field: string): unknown => {
  switch (field) {
    case "headRepository": {
      const repo = objOrNull(pr.headRepository)
      return repo === null ? null : { id: s(repo.id), name: s(repo.name), nameWithOwner: s(repo.nameWithOwner) }
    }
    case "statusCheckRollup":
      return exportStatusCheckRollup(pr)
    case "commits":
      return nodes(pr.commits).map((node) => {
        const commit = obj(node.commit)
        return sortedMap({
          oid: s(commit.oid),
          messageHeadline: s(commit.messageHeadline),
          messageBody: s(commit.messageBody),
          committedDate: time(commit.committedDate),
          authoredDate: time(commit.authoredDate),
          authors: nodes(commit.authors).map((a) =>
            sortedMap({ name: s(a.name), email: s(a.email), id: s(obj(a.user).id), login: s(obj(a.user).login) }),
          ),
        })
      })
    case "comments":
      return nodes(pr.comments).map(exportComment)
    case "assignees":
      return nodes(pr.assignees).map((u) => ({ id: s(u.id), login: s(u.login), name: s(u.name), databaseId: n(u.databaseId) }))
    case "labels":
      return nodes(pr.labels).map((l) => ({ id: s(l.id), name: s(l.name), description: s(l.description), color: s(l.color) }))
    case "projectCards":
      // github.com no longer serves classic projects, so the CLI never fills this list.
      return null
    case "projectItems":
      return nodes(pr.projectItems).map((item) =>
        sortedMap({
          status: { optionId: s(obj(item.status).optionId), name: s(obj(item.status).name) },
          title: s(obj(item.project).title),
        }),
      )
    case "reviews":
      return nodes(pr.reviews).map(exportReview)
    case "latestReviews":
      return nodes(pr.latestReviews).map(exportReview)
    case "files":
      return nodes(pr.files).map((f) => ({ path: s(f.path), additions: n(f.additions), deletions: n(f.deletions) }))
    case "reviewRequests":
      return nodes(pr.reviewRequests).flatMap((req) => {
        const r = obj(req.requestedReviewer)
        if (s(r.__typename) === "User") return [sortedMap({ __typename: "User", login: s(r.login) })]
        if (s(r.__typename) === "Team") {
          return [sortedMap({ __typename: "Team", name: s(r.name), slug: `${s(obj(r.organization).login)}/${s(r.slug)}` })]
        }
        return []
      })
    case "closingIssuesReferences":
      return nodes(pr.closingIssuesReferences).map(exportOwnerRepository)
    case "author":
      return exportAuthor(pr.author)
    case "mergedBy":
      return objOrNull(pr.mergedBy) === null ? null : exportAuthor(pr.mergedBy)
    case "headRepositoryOwner": {
      const owner = obj(pr.headRepositoryOwner)
      return {
        ...(s(owner.id) === "" ? {} : { id: s(owner.id) }),
        ...(s(owner.name) === "" ? {} : { name: s(owner.name) }),
        login: s(owner.login),
      }
    }
    case "milestone": {
      const m = objOrNull(pr.milestone)
      return m === null ? null : { number: n(m.number), title: s(m.title), description: s(m.description), dueOn: timePtr(m.dueOn) }
    }
    case "reactionGroups":
      return exportReactionGroups(pr.reactionGroups)
    case "mergeCommit":
    case "potentialMergeCommit": {
      const c = objOrNull(pr[field])
      return c === null ? null : { oid: s(c.oid) }
    }
    case "autoMergeRequest": {
      const a = objOrNull(pr.autoMergeRequest)
      if (a === null) return null
      const ptr = (v: unknown) => (typeof v === "string" ? v : null)
      return {
        authorEmail: ptr(a.authorEmail),
        commitBody: ptr(a.commitBody),
        commitHeadline: ptr(a.commitHeadline),
        mergeMethod: s(a.mergeMethod),
        enabledAt: time(a.enabledAt),
        enabledBy: exportAuthor(a.enabledBy),
      }
    }
    case "closedAt":
    case "mergedAt":
      return timePtr(pr[field])
    case "createdAt":
    case "updatedAt":
      return time(pr[field])
    case "number":
    case "additions":
    case "deletions":
    case "changedFiles":
      return n(pr[field])
    case "closed":
    case "isCrossRepository":
    case "isDraft":
    case "maintainerCanModify":
      return b(pr[field])
    default:
      return s(pr[field])
  }
}

/** `PullRequest.ExportData(fields)`: a Go map, so its keys come out sorted. */
export const exportPullRequest = (pr: Raw, fields: ReadonlyArray<string>): Record<string, unknown> =>
  sortedMap(Object.fromEntries(fields.map((f) => [f, exportField(pr, f)])))

// ---- presentation helpers shared by the commands ----

/** `shared.PrStateWithDraft`. */
export const stateWithDraft = (pr: Raw): string => (b(pr.isDraft) && s(pr.state) === "OPEN" ? "DRAFT" : s(pr.state))

/** `PullRequest.HeadLabel`. */
export const headLabel = (pr: Raw): string =>
  b(pr.isCrossRepository) ? `${s(obj(pr.headRepositoryOwner).login)}:${s(pr.headRefName)}` : s(pr.headRefName)

/** `text.RemoveExcessiveWhitespace`. */
export const squashWhitespace = (text: string): string => text.trim().replace(/\s+/g, " ")

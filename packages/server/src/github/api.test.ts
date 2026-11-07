import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { GitHub, GitHubLive, type ApiRequest, type RepoSlug, commentMismatch } from "./api"

const repo: RepoSlug = { owner: "jarenm1", name: "kestrel" }
const prPath = "/repos/jarenm1/kestrel/pulls/7"

interface Recorded {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

/** A local stand-in for api.github.com that records every request it receives. */
const fakeGitHub = (route: (request: Recorded) => { readonly json?: unknown; readonly status?: number }) => {
  const requests: Recorded[] = []
  const auth: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const raw = await request.text()
      auth.push(request.headers.get("authorization"))
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname + url.search,
        body: raw === "" ? undefined : JSON.parse(raw),
      }
      requests.push(recorded)
      const { json, status = 200 } = route(recorded)
      return new Response(json === undefined ? "" : JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { requests, auth, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const runAgainst = <A>(url: string, program: Effect.Effect<A, unknown, GitHub>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(GitHubLive.pipe(Layer.provide(Layer.succeed(Config, { githubApiUrl: url } as unknown as ServerConfig)))),
    ),
  )

const issueJson = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  html_url: "https://github.com/jarenm1/kestrel/issues/1",
  title: "Fix ?? operator",
  body: "The `??` operator is broken.",
  state: "open",
  state_reason: null,
  created_at: "2024-01-02T03:04:05Z",
  updated_at: "2024-02-03T04:05:06Z",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  ...overrides,
})

const commentJson = (overrides: Record<string, unknown> = {}) => ({
  body: "Confirmed on main.",
  html_url: "https://github.com/jarenm1/kestrel/issues/1#issuecomment-1",
  created_at: "2024-01-03T00:00:00Z",
  user: { login: "bob" },
  ...overrides,
})

const pullRequestJson = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: "PR_node",
  html_url: "https://github.com/jarenm1/kestrel/pull/7",
  title: "Old title",
  state: "open",
  merged: false,
  draft: false,
  user: { login: "alice" },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  merged_at: null,
  closed_at: null,
  labels: [{ name: "bug" }],
  requested_reviewers: [{ login: "bob" }],
  mergeable: true,
  mergeable_state: "clean",
  head: { sha: "abc123", ref: "cloudagents/topic" },
  base: { ref: "main" },
  ...overrides,
})

test("updatePullRequest sends only the fields it was given, then returns the pull request as GitHub has it", async () => {
  const state = { title: "Old title", draft: false }
  const gh = fakeGitHub(({ method, path, body }) => {
    if (method === "PATCH" && path === prPath) {
      state.title = (body as { title: string }).title
      return { json: pullRequestJson({ title: state.title, draft: state.draft }) }
    }
    if (method === "GET" && path === prPath) return { json: pullRequestJson({ title: state.title, draft: state.draft }) }
    return { status: 500 }
  })
  try {
    const pr = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) =>
        github.updatePullRequest("token", repo, 7, { title: "New title", body: undefined, draft: undefined }),
      ),
    )
    expect(pr.title).toBe("New title")
    expect(gh.requests).toEqual([
      { method: "PATCH", path: prPath, body: { title: "New title" } },
      { method: "GET", path: prPath, body: undefined },
    ])
  } finally {
    gh.stop()
  }
})

test("updatePullRequest toggles draft state through GraphQL, since REST cannot change it", async () => {
  const state = { title: "Old title", draft: true }
  const gh = fakeGitHub(({ method, path, body }) => {
    if (method === "PATCH" && path === prPath) {
      state.title = (body as { title: string }).title
      return { json: pullRequestJson({ title: state.title, draft: state.draft }) }
    }
    if (method === "GET" && path === prPath) return { json: pullRequestJson({ title: state.title, draft: state.draft }) }
    if (method === "POST" && path === "/graphql") {
      state.draft = false
      return { json: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } }
    }
    return { status: 500 }
  })
  try {
    const pr = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) =>
        github.updatePullRequest("token", repo, 7, { title: "New title", draft: false }),
      ),
    )
    expect(pr).toMatchObject({ nodeId: "PR_node", title: "New title", draft: false })
    expect(gh.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `PATCH ${prPath}`,
      `GET ${prPath}`,
      "POST /graphql",
      `GET ${prPath}`,
    ])
    const mutation = gh.requests[2]?.body as { query: string; variables: unknown }
    expect(mutation.query).toContain("markPullRequestReadyForReview")
    expect(mutation.variables).toEqual({ id: "PR_node" })
  } finally {
    gh.stop()
  }
})

test("updatePullRequest leaves draft state alone when it already matches", async () => {
  const gh = fakeGitHub(({ method, path }) =>
    method === "GET" && path === prPath ? { json: pullRequestJson({ draft: true }) } : { status: 500 },
  )
  try {
    await runAgainst(gh.url, Effect.flatMap(GitHub, (github) => github.updatePullRequest("token", repo, 7, { draft: true })))
    expect(gh.requests.map(({ method }) => method)).toEqual(["GET", "GET"])
  } finally {
    gh.stop()
  }
})

test("a failed GraphQL draft change surfaces GitHub's message", async () => {
  const gh = fakeGitHub(({ method, path }) => {
    if (method === "GET" && path === prPath) return { json: pullRequestJson({ draft: true }) }
    if (method === "POST" && path === "/graphql") {
      return { json: { errors: [{ message: "Pull request is not in a state that allows this change" }] } }
    }
    return { status: 500 }
  })
  try {
    const result = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.updatePullRequest("token", repo, 7, { draft: false })).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
    expect(result).toMatchObject({ left: { message: "Pull request is not in a state that allows this change" } })
  } finally {
    gh.stop()
  }
})

test("comments: create on the conversation, reply on a review thread, edit and delete by kind", async () => {
  const gh = fakeGitHub(({ method, path }) => {
    if (method === "POST" && path === "/repos/jarenm1/kestrel/issues/7/comments") return { json: { id: 90, html_url: "https://c/90" } }
    if (method === "POST" && path === "/repos/jarenm1/kestrel/pulls/7/comments/55/replies") return { json: { id: 91, html_url: "https://c/91" } }
    if (method === "PATCH" && path === "/repos/jarenm1/kestrel/pulls/comments/55") return { json: { id: 55, html_url: "https://c/55" } }
    if (method === "PATCH" && path === "/repos/jarenm1/kestrel/issues/comments/9") return { json: { id: 9, html_url: "https://c/9" } }
    if (method === "DELETE" && path === "/repos/jarenm1/kestrel/pulls/comments/55") return { status: 204 }
    return { status: 500 }
  })
  try {
    const result = await runAgainst(
      gh.url,
      Effect.gen(function* () {
        const github = yield* GitHub
        const created = yield* github.createComment("token", repo, 7, "looks good")
        const reply = yield* github.replyToReviewComment("token", repo, 7, 55, "thanks")
        const edited = yield* github.editComment("token", repo, "review", 55, "edited")
        const editedConversation = yield* github.editComment("token", repo, "conversation", 9, "edited too")
        yield* github.deleteComment("token", repo, "review", 55)
        return { created, reply, edited, editedConversation }
      }),
    )
    expect(result.created).toEqual({ id: 90, url: "https://c/90" })
    expect(result.reply).toEqual({ id: 91, url: "https://c/91" })
    expect(result.edited).toEqual({ id: 55, url: "https://c/55" })
    expect(result.editedConversation).toEqual({ id: 9, url: "https://c/9" })
    expect(gh.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/repos/jarenm1/kestrel/issues/7/comments", body: { body: "looks good" } },
      { method: "POST", path: "/repos/jarenm1/kestrel/pulls/7/comments/55/replies", body: { body: "thanks" } },
      { method: "PATCH", path: "/repos/jarenm1/kestrel/pulls/comments/55", body: { body: "edited" } },
      { method: "PATCH", path: "/repos/jarenm1/kestrel/issues/comments/9", body: { body: "edited too" } },
      { method: "DELETE", path: "/repos/jarenm1/kestrel/pulls/comments/55", body: undefined },
    ])
  } finally {
    gh.stop()
  }
})

test("reviewers are requested and withdrawn with user logins and team slugs", async () => {
  const gh = fakeGitHub(() => ({ status: 201, json: pullRequestJson() }))
  try {
    await runAgainst(
      gh.url,
      Effect.gen(function* () {
        const github = yield* GitHub
        const request = { reviewers: ["octocat"], teamReviewers: ["core"] }
        yield* github.requestReviewers("token", repo, 7, request)
        yield* github.removeReviewers("token", repo, 7, request)
      }),
    )
    const expectedBody = { reviewers: ["octocat"], team_reviewers: ["core"] }
    expect(gh.requests).toEqual([
      { method: "POST", path: "/repos/jarenm1/kestrel/pulls/7/requested_reviewers", body: expectedBody },
      { method: "DELETE", path: "/repos/jarenm1/kestrel/pulls/7/requested_reviewers", body: expectedBody },
    ])
  } finally {
    gh.stop()
  }
})

test("labels are added in one call and removed one at a time, with the name URL-encoded", async () => {
  const gh = fakeGitHub(() => ({ json: [] }))
  try {
    await runAgainst(
      gh.url,
      Effect.gen(function* () {
        const github = yield* GitHub
        yield* github.addLabels("token", repo, 7, ["bug", "ui"])
        yield* github.removeLabel("token", repo, 7, "needs review/now")
      }),
    )
    expect(gh.requests).toEqual([
      { method: "POST", path: "/repos/jarenm1/kestrel/issues/7/labels", body: { labels: ["bug", "ui"] } },
      { method: "DELETE", path: "/repos/jarenm1/kestrel/issues/7/labels/needs%20review%2Fnow", body: undefined },
    ])
  } finally {
    gh.stop()
  }
})

test("getComment reports the pull request a review or conversation comment is on, and its author", async () => {
  const gh = fakeGitHub(({ path }) => {
    if (path === "/repos/jarenm1/kestrel/pulls/comments/55") {
      return { json: { pull_request_url: "https://api.github.com/repos/jarenm1/kestrel/pulls/7", issue_url: "https://api.github.com/repos/jarenm1/kestrel/issues/7", user: { login: "jarenm1" } } }
    }
    if (path === "/repos/jarenm1/kestrel/issues/comments/9") {
      return { json: { issue_url: "https://api.github.com/repos/jarenm1/kestrel/issues/12", user: null } }
    }
    return { status: 500 }
  })
  try {
    const result = await runAgainst(
      gh.url,
      Effect.gen(function* () {
        const github = yield* GitHub
        return {
          review: yield* github.getComment("token", repo, "review", 55),
          conversation: yield* github.getComment("token", repo, "conversation", 9),
        }
      }),
    )
    expect(result).toEqual({
      review: { pullRequest: 7, author: "jarenm1" },
      conversation: { pullRequest: 12, author: "ghost" },
    })
  } finally {
    gh.stop()
  }
})

test("viewerLogin reads the login of the account the token belongs to", async () => {
  const gh = fakeGitHub(({ path }) => (path === "/user" ? { json: { login: "jarenm1" } } : { status: 500 }))
  try {
    expect(await runAgainst(gh.url, Effect.flatMap(GitHub, (github) => github.viewerLogin("token", repo)))).toBe("jarenm1")
  } finally {
    gh.stop()
  }
})

test("commit identity rejects unverified profiles and does not cache failed lookups", async () => {
  let profile: unknown = { login: "someone-else", id: 123 }
  const gh = fakeGitHub(() => ({ json: profile }))
  try {
    await runAgainst(gh.url, Effect.gen(function* () {
      const github = yield* GitHub
      const mismatch = yield* Effect.either(github.commitIdentity("alice", "token"))
      expect(mismatch._tag).toBe("Left")
      profile = { login: "alice", id: -1 }
      const invalid = yield* Effect.either(github.commitIdentity("alice", "token"))
      expect(invalid._tag).toBe("Left")
      profile = { login: "Alice", id: 156641090 }
      expect(yield* github.commitIdentity("alice", "token")).toEqual({
        name: "Alice", email: "156641090+Alice@users.noreply.github.com",
      })
      profile = { login: "other", id: 1 }
      expect(yield* github.commitIdentity("ALICE", "token")).toEqual({
        name: "Alice", email: "156641090+Alice@users.noreply.github.com",
      })
    }))
  } finally {
    gh.stop()
  }
})

for (const status of [401, 403]) {
  test(`commit identity survives a connected token rejected with ${status}`, async () => {
    let calls = 0
    const gh = fakeGitHub(() => ++calls === 1
      ? { status, json: { message: "Bad credentials" } }
      : { json: { login: "alice", id: 156641090 } })
    try {
      expect(await runAgainst(gh.url, Effect.flatMap(GitHub, (github) => github.commitIdentity("alice", "expired")))).toEqual({
        name: "alice", email: "156641090+alice@users.noreply.github.com",
      })
      expect(gh.auth).toEqual(["Bearer expired", null])
    } finally {
      gh.stop()
    }
  })
}

test("commit identity reports anonymous lookup failure without repeated retries", async () => {
  let calls = 0
  const gh = fakeGitHub(() => ({ status: ++calls === 1 ? 401 : 404 }))
  try {
    const result = await runAgainst(gh.url, Effect.flatMap(GitHub, (github) => Effect.either(github.commitIdentity("missing", "expired"))))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") expect(result.left.status).toBe(404)
    expect(gh.auth).toEqual(["Bearer expired", null])
  } finally {
    gh.stop()
  }
})

test("readReference reads an issue's body and conversation, sending the token only to GitHub", async () => {
  const gh = fakeGitHub(({ path }) => {
    if (path === "/repos/jarenm1/kestrel/issues/1") return { json: issueJson() }
    if (path === "/repos/jarenm1/kestrel/issues/1/comments?per_page=100") {
      return { json: [commentJson()] }
    }
    return { status: 500 }
  })
  try {
    const reference = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("secret-token", repo, 1, "issue")),
    )
    expect(reference).toMatchObject({
      kind: "issue",
      number: 1,
      title: "Fix ?? operator",
      body: "The `??` operator is broken.",
      state: "open",
      stateReason: null,
      author: "alice",
      url: "https://github.com/jarenm1/kestrel/issues/1",
      createdAt: "2024-01-02T03:04:05Z",
      updatedAt: "2024-02-03T04:05:06Z",
      labels: ["bug"],
    })
    expect(reference.kind === "issue" ? reference.conversation : []).toEqual([
      {
        author: "bob",
        body: "Confirmed on main.",
        url: "https://github.com/jarenm1/kestrel/issues/1#issuecomment-1",
        createdAt: "2024-01-03T00:00:00Z",
      },
    ])
    expect(gh.auth).toEqual(["Bearer secret-token", "Bearer secret-token"])
    expect(gh.requests.map(({ path }) => path).some((path) => path.includes("/pulls"))).toBe(false)
  } finally {
    gh.stop()
  }
})

test("readReference refuses a pull request read as an issue without falling through to the pull request endpoint", async () => {
  const gh = fakeGitHub(({ path }) =>
    path === "/repos/jarenm1/kestrel/issues/7"
      ? { json: issueJson({ number: 7, title: "Add references", pull_request: { url: "https://api.github.com/repos/jarenm1/kestrel/pulls/7" } }) }
      : { status: 500 },
  )
  try {
    const result = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("token", repo, 7, "issue")).pipe(Effect.either),
    )
    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: '#7 in jarenm1/kestrel is a pull request, not an issue; read it with kind "pr"' },
    })
    expect(gh.requests.map(({ path }) => path)).toEqual(["/repos/jarenm1/kestrel/issues/7"])
  } finally {
    gh.stop()
  }
})

test("readReference refuses an issue read as a pull request without falling through to the pull request endpoint", async () => {
  const gh = fakeGitHub(({ path }) => (path === "/repos/jarenm1/kestrel/issues/1" ? { json: issueJson() } : { status: 500 }))
  try {
    const result = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("token", repo, 1, "pr")).pipe(Effect.either),
    )
    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: '#1 in jarenm1/kestrel is an issue, not a pull request; read it with kind "issue"' },
    })
    expect(gh.requests.map(({ path }) => path)).toEqual(["/repos/jarenm1/kestrel/issues/1"])
  } finally {
    gh.stop()
  }
})

test("readReference reports a missing reference explicitly and never puts the token in the error", async () => {
  const gh = fakeGitHub(() => ({ status: 404 }))
  try {
    const result = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("secret-token", repo, 99, "issue")).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toContain("no issue or pull request #99 in jarenm1/kestrel")
      expect(result.left.message).not.toContain("secret-token")
    }
    expect(gh.auth).toEqual(["Bearer secret-token"])
  } finally {
    gh.stop()
  }
})

test("readReference returns a pull request's status, checks, changed files and conversation", async () => {
  const gh = fakeGitHub(({ path }) => {
    if (path === "/repos/jarenm1/kestrel/issues/156") {
      return {
        json: issueJson({
          number: 156,
          title: "Add references",
          body: "PR body",
          state: "closed",
          labels: [{ name: "enhancement" }],
          pull_request: { url: "https://api.github.com/repos/jarenm1/kestrel/pulls/156" },
        }),
      }
    }
    if (path === "/repos/jarenm1/kestrel/pulls/156") {
      return {
        json: pullRequestJson({
          number: 156,
          title: "Add references",
          merged: true,
          head: { sha: "abc123", ref: "cloudagents/topic" },
          base: { ref: "main" },
        }),
      }
    }
    if (path === "/repos/jarenm1/kestrel/pulls/156/reviews?per_page=100") {
      return { json: [{ state: "APPROVED", body: "Looks good", html_url: "https://github.com/jarenm1/kestrel/pull/156#review", submitted_at: "2024-01-04T00:00:00Z", user: { login: "reviewer" } }] }
    }
    if (path === "/repos/jarenm1/kestrel/pulls/156/comments?sort=created&direction=desc&per_page=100") {
      return { json: [{ path: "src/a.ts", line: 12, body: "nit", html_url: "https://github.com/jarenm1/kestrel/pull/156#comment", created_at: "2024-01-05T00:00:00Z", user: { login: "reviewer" } }] }
    }
    if (path === "/repos/jarenm1/kestrel/issues/156/comments?per_page=100") return { json: [commentJson()] }
    if (path === "/repos/jarenm1/kestrel/pulls/156/files?per_page=100") {
      return { json: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1 }] }
    }
    if (path === "/repos/jarenm1/kestrel/commits/abc123/check-runs?per_page=100") {
      return { json: { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] } }
    }
    return { status: 500 }
  })
  try {
    const reference = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("token", repo, 156, "pr")),
    )
    expect(reference).toMatchObject({
      kind: "pr",
      number: 156,
      title: "Add references",
      body: "PR body",
      state: "merged",
      author: "alice",
      labels: ["enhancement"],
      baseRef: "main",
      headRef: "cloudagents/topic",
      headSha: "abc123",
      reviewDecision: "approved",
      checks: { total: 1, passed: 1, failing: [], pending: [] },
      files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
    })
    expect(reference.kind === "pr" ? reference.reviews : []).toEqual([
      { author: "reviewer", state: "APPROVED", body: "Looks good", url: "https://github.com/jarenm1/kestrel/pull/156#review", submittedAt: "2024-01-04T00:00:00Z" },
    ])
    expect(reference.kind === "pr" ? reference.reviewComments : []).toEqual([
      { path: "src/a.ts", line: 12, author: "reviewer", body: "nit", url: "https://github.com/jarenm1/kestrel/pull/156#comment", createdAt: "2024-01-05T00:00:00Z" },
    ])
    expect(reference.kind === "pr" ? reference.conversation : []).toHaveLength(1)
  } finally {
    gh.stop()
  }
})

test("readReference keeps a pull request readable when GitHub will not report check runs", async () => {
  const gh = fakeGitHub(({ path }) => {
    if (path === "/repos/jarenm1/kestrel/issues/7") {
      return { json: issueJson({ number: 7, title: "Add references", pull_request: { url: "https://api.github.com/repos/jarenm1/kestrel/pulls/7" } }) }
    }
    if (path === "/repos/jarenm1/kestrel/pulls/7") return { json: pullRequestJson({ title: "Add references" }) }
    if (path === "/repos/jarenm1/kestrel/pulls/7/reviews?per_page=100") return { json: [] }
    if (path === "/repos/jarenm1/kestrel/pulls/7/comments?sort=created&direction=desc&per_page=100") return { json: [] }
    if (path === "/repos/jarenm1/kestrel/issues/7/comments?per_page=100") return { json: [] }
    if (path === "/repos/jarenm1/kestrel/pulls/7/files?per_page=100") return { json: [] }
    if (path === "/repos/jarenm1/kestrel/commits/abc123/check-runs?per_page=100") return { status: 403 }
    return { status: 500 }
  })
  try {
    const reference = await runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => github.readReference("token", repo, 7, "pr")),
    )
    expect(reference).toMatchObject({ kind: "pr", number: 7, title: "Add references", body: "The `??` operator is broken.", checks: null })
  } finally {
    gh.stop()
  }
})

test("gh api without checkouts sends only reads, and the token only to the API", async () => {
  const elsewhere = fakeGitHub(() => ({ json: {} }))
  const gh = fakeGitHub(() => ({ json: { ok: true } }))
  // The API redirecting off itself, as GitHub does for archives; the next hop must go without the token.
  const redirecting = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 302, headers: { location: `${elsewhere.url}/archive` } }),
  })
  const read = (url: string, request: Partial<ApiRequest>) =>
    runAgainst(
      url,
      Effect.flatMap(GitHub, (github) => Effect.either(github.api("token", { method: "GET", path: "", headers: [], body: null, ...request }, []))),
    )
  try {
    for (const write of [
      { method: "POST", path: "repos/jarenm1/kestrel/issues", body: '{"title":"x"}' },
      { method: "DELETE", path: "repos/jarenm1/kestrel" },
      { method: "GET", path: "repos/jarenm1/kestrel", headers: [["X-HTTP-Method-Override", "DELETE"] as const] },
      { method: "POST", path: "graphql", body: JSON.stringify({ query: 'query A { viewer { login } } mutation B { addStar(input: {starrableId: "x"}) { clientMutationId } }' }) },
      { method: "POST", path: "graphql", body: JSON.stringify([{ query: "query { viewer { login } }" }]) },
      { method: "GET", path: `${elsewhere.url}/repos/jarenm1/kestrel` },
    ]) {
      expect((await read(gh.url, write))._tag).toBe("Left")
    }
    expect(gh.requests).toEqual([])
    expect(elsewhere.requests).toEqual([])

    expect((await read(gh.url, { path: "repos/jarenm1/kestrel" }))._tag).toBe("Right")
    expect((await read(gh.url, { method: "POST", path: "graphql", body: JSON.stringify({ query: "{ viewer { login } }" }) }))._tag).toBe("Right")
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repos/jarenm1/kestrel", "POST /graphql"])
    expect(gh.auth).toEqual(["Bearer token", "Bearer token"])

    expect((await read(`http://127.0.0.1:${redirecting.port}`, { path: "repos/jarenm1/kestrel/tarball" }))._tag).toBe("Right")
    expect(elsewhere.requests.map((r) => r.path)).toEqual(["/archive"])
    expect(elsewhere.auth).toEqual([null])
  } finally {
    gh.stop()
    elsewhere.stop()
    redirecting.stop(true)
  }
})

test("gh api writes only the allowlisted endpoints, on the thread's checkouts", async () => {
  const gh = fakeGitHub(({ body }) => {
    const request = body as { query?: string; variables?: { ids?: string[] } }
    if (request?.query?.includes("nodes(ids:")) {
      const inThread = request.variables?.ids?.[0] === "T_in"
      return { json: { data: { nodes: [{ repository: { nameWithOwner: inThread ? "jarenm1/kestrel" : "other/repo" } }] } } }
    }
    return { json: { ok: true } }
  })
  const send = (request: Partial<ApiRequest>) =>
    runAgainst(
      gh.url,
      Effect.flatMap(GitHub, (github) => Effect.either(github.api("token", { method: "POST", path: "", headers: [], body: null, ...request }, [repo]))),
    )
  const resolve = (threadId: string) =>
    JSON.stringify({ query: "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }", variables: { id: threadId } })
  try {
    for (const refused of [
      { path: "repos/other/repo/issues", body: '{"title":"x"}' },
      { path: "repos/jarenm1/kestrel/issues/../../../other/repo/issues", body: '{"title":"x"}' },
      { method: "PUT", path: "repos/jarenm1/kestrel/pulls/7/merge" },
      { method: "PUT", path: "repos/jarenm1/kestrel/contents/README.md", body: '{"message":"x","content":""}' },
      { method: "PATCH", path: "repos/jarenm1/kestrel/issues/7", body: '{"assignees":["octocat"]}' },
      { path: "repos/jarenm1/kestrel/issues/7/comments?body=x", body: '{"body":"x"}' },
      { path: "graphql", body: JSON.stringify({ query: 'mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }' }) },
      { path: "graphql", body: JSON.stringify({ query: 'mutation { resolveReviewThread(input: {threadId: "T_in"}) { clientMutationId } addStar(input: {starrableId: "x"}) { clientMutationId } }' }) },
    ]) {
      expect((await send(refused))._tag).toBe("Left")
    }
    expect(gh.requests).toEqual([])

    for (const allowed of [
      { path: "repos/JarenM1/Kestrel/issues", body: '{"title":"Flaky test","labels":["bug"]}' },
      { path: "repos/jarenm1/kestrel/pulls/7/comments/99/replies", body: '{"body":"Fixed."}' },
      { method: "DELETE", path: "repos/jarenm1/kestrel/issues/7/labels/area%2Fui" },
      { path: "repos/jarenm1/kestrel/actions/runs/5/rerun-failed-jobs" },
      { path: "graphql", body: resolve("T_in") },
    ]) {
      expect((await send(allowed))._tag).toBe("Right")
    }
    // A review thread in another repository is looked up, then refused.
    expect((await send({ path: "graphql", body: resolve("T_out") }))._tag).toBe("Left")
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /repos/JarenM1/Kestrel/issues",
      "POST /repos/jarenm1/kestrel/pulls/7/comments/99/replies",
      "DELETE /repos/jarenm1/kestrel/issues/7/labels/area%2Fui",
      "POST /repos/jarenm1/kestrel/actions/runs/5/rerun-failed-jobs",
      "POST /graphql",
      "POST /graphql",
      "POST /graphql",
    ])
    expect(gh.requests.filter((r) => JSON.stringify(r.body ?? null).includes("resolveReviewThread")).map((r) => r.body)).toEqual([JSON.parse(resolve("T_in"))])
  } finally {
    gh.stop()
  }
})

test("commentMismatch refuses comments on another pull request or written by someone else", () => {
  const own = { pullRequest: 7, author: "jarenm1" }
  expect(commentMismatch(own, 7, "jarenm1")).toBeNull()
  expect(commentMismatch({ ...own, pullRequest: 8 }, 7, "jarenm1")).toBe("it is not on pull request #7")
  expect(commentMismatch({ ...own, pullRequest: null }, 7, "jarenm1")).toBe("it is not on pull request #7")
  expect(commentMismatch({ ...own, author: "octocat" }, 7, "jarenm1")).toBe(
    "it was written by octocat, not by the connected account jarenm1",
  )
})

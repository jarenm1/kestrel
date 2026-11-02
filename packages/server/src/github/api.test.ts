import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Config, type ServerConfig } from "../config"
import { GitHub, GitHubLive, type RepoSlug, commentMismatch } from "./api"

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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const raw = await request.text()
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
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const runAgainst = <A>(url: string, program: Effect.Effect<A, unknown, GitHub>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(GitHubLive.pipe(Layer.provide(Layer.succeed(Config, { githubApiUrl: url } as unknown as ServerConfig)))),
    ),
  )

const pullRequestJson = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: "PR_node",
  html_url: "https://github.com/jarenm1/kestrel/pull/7",
  title: "Old title",
  state: "open",
  merged: false,
  draft: false,
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

test("commentMismatch refuses comments on another pull request or written by someone else", () => {
  const own = { pullRequest: 7, author: "jarenm1" }
  expect(commentMismatch(own, 7, "jarenm1")).toBeNull()
  expect(commentMismatch({ ...own, pullRequest: 8 }, 7, "jarenm1")).toBe("it is not on pull request #7")
  expect(commentMismatch({ ...own, pullRequest: null }, 7, "jarenm1")).toBe("it is not on pull request #7")
  expect(commentMismatch({ ...own, author: "octocat" }, 7, "jarenm1")).toBe(
    "it was written by octocat, not by the connected account jarenm1",
  )
})

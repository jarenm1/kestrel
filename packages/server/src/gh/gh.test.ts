import { describe, expect, test } from "bun:test"
import type { OpenPullRequestInput } from "../core/service"
import type { ApiRequest, ApiResponse, GraphQLResponse } from "../github/api"
import { parseFlags, bool, slice, str } from "./argv"
import { runGh, type GhResult } from "./cli"
import type { GhBackend } from "./context"
import { decodeGhRequest } from "./handler"

const DIR = "/work/threads/t1/widget"
const PR_URL = "https://github.com/acme/widget/pull/7"

interface Recorded {
  readonly queries: string[]
  readonly opened: OpenPullRequestInput[]
  readonly mutations: unknown[]
}

/** A thread with one checkout of acme/widget on branch `fix-login_bug`; GraphQL answers come from `answer`. */
const backend = (answer: (query: string, variables: Readonly<Record<string, unknown>>) => unknown, commitLog = ""): [GhBackend, Recorded] => {
  const recorded: Recorded = { queries: [], opened: [], mutations: [] }
  const reject = () => Promise.reject(new Error("not expected in this test"))
  const fake: GhBackend = {
    checkouts: async () => [
      {
        checkout: { id: "c1", repo: "acme/widget", dir: "widget", branch: "fix-login_bug", baseBranch: "main", createdAt: "2026-01-01T00:00:00Z" },
        dir: DIR,
        github: { owner: "acme", name: "widget" },
      },
    ],
    graphql: async (_checkout, query, variables): Promise<GraphQLResponse> => {
      recorded.queries.push(query)
      return { data: answer(query, variables), errors: [] }
    },
    pullRequestDiff: reject,
    commitLog: async () => commitLog,
    openPullRequest: async (input) => {
      recorded.opened.push(input)
      return {
        created: true,
        pullRequest: { number: 8, nodeId: "PR_8", url: "https://github.com/acme/widget/pull/8", title: input.title, state: "open", draft: input.draft, author: "alice", createdAt: "2025-12-30T00:00:00Z", updatedAt: "2025-12-31T00:00:00Z", mergedAt: null, closedAt: null, additions: 1, deletions: 0, changedFiles: 1, labels: [], requestedReviewers: [], headSha: "abc", baseRef: input.base ?? "main", headRef: "fix-login_bug", headRepo: "acme/widget", mergeable: null, mergeableState: "unknown" },
      }
    },
    updatePullRequest: reject,
    comment: reject,
    review: async (input) => {
      recorded.mutations.push({ review: input })
      return { url: "", state: "" }
    },
    changeReviewers: async (input) => {
      recorded.mutations.push({ reviewers: input })
    },
    changeLabels: async (input) => {
      recorded.mutations.push({ labels: input })
    },
    api: reject,
  }
  return [fake, recorded]
}

const gh = (fake: GhBackend, argv: string[]): Promise<GhResult> =>
  runGh({ backend: fake, cwd: DIR, files: new Map(), signal: new AbortController().signal, stdout: "", stderr: "" }, argv)

const noPullRequests = { repository: { pullRequests: { nodes: [] }, defaultBranchRef: { name: "main" } } }

describe("gh pr create", () => {
  test("refuses when an open pull request already exists for the branch", async () => {
    const [fake, recorded] = backend(() => ({
      repository: {
        pullRequests: { nodes: [{ state: "OPEN", baseRefName: "main", headRefName: "fix-login_bug", isCrossRepository: false, url: PR_URL }] },
        defaultBranchRef: { name: "main" },
      },
    }))
    const result = await gh(fake, ["pr", "create", "--title", "t", "--body", "b"])
    expect(result).toEqual({
      stdout: "",
      stderr: `a pull request for branch "fix-login_bug" into branch "main" already exists:\n${PR_URL}\n`,
      exitCode: 1,
    })
    expect(recorded.opened).toEqual([])
  })

  test("--fill over several commits titles it after the branch, lists the commits, then adds labels and reviewers", async () => {
    const log = "bbbbbbb\0second\0\0\naaaaaaa\0first\0details\n\0"
    const [fake, recorded] = backend(() => noPullRequests, log)
    const result = await gh(fake, ["pr", "create", "--fill", "-B", "release", "-l", "bug", "--reviewer", "alice,acme/core", "--draft"])
    expect(result).toEqual({ stdout: "https://github.com/acme/widget/pull/8\n", stderr: "", exitCode: 0 })
    expect(recorded.opened).toEqual([{ title: "fix login bug", body: "- **first**\n- **second**\n", draft: true, checkoutId: "c1", base: "release" }])
    expect(recorded.mutations).toEqual([
      { labels: { checkoutId: "c1", number: 8, action: "add", labels: ["bug"] } },
      { reviewers: { checkoutId: "c1", number: 8, action: "add", reviewers: ["alice"], teamReviewers: ["core"] } },
    ])
  })

  test("--head can only name the checkout's own branch", async () => {
    const [fake, recorded] = backend(() => noPullRequests)
    const result = await gh(fake, ["pr", "create", "-t", "t", "-b", "b", "--head", "someone:other"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--head cannot name another")
    expect(recorded.opened).toEqual([])
  })
})

describe("scope", () => {
  test("repositories outside the thread's checkouts are refused before any GitHub call", async () => {
    const [fake, recorded] = backend(() => noPullRequests)
    for (const argv of [
      ["pr", "view", "1", "-R", "other/repo"],
      ["pr", "view", "https://github.com/other/repo/pull/1"],
      ["pr", "list", "--repo", "github.example.com/acme/widget"],
    ]) {
      const result = await gh(fake, argv)
      expect(result.exitCode).toBe(1)
    }
    expect(recorded.queries).toEqual([])
  })

  test("list --search cannot reach past the repository", async () => {
    const [fake, recorded] = backend(() => ({
      search: {
        nodes: [
          { number: 3, title: "elsewhere", state: "OPEN", url: "https://github.com/other/repo/pull/3", headRefName: "x", isCrossRepository: false, isDraft: false, createdAt: "2026-01-02T00:00:00Z" },
          { number: 7, title: "ours", state: "OPEN", url: PR_URL, headRefName: "y", isCrossRepository: false, isDraft: false, createdAt: "2026-01-03T00:00:00Z" },
        ],
        pageInfo: { hasNextPage: false },
      },
    }))
    for (const search of ["fix ) OR ( is:open", "repo:other/repo", "org:acme bug"]) {
      expect((await gh(fake, ["pr", "list", "--search", search])).exitCode).toBe(1)
    }
    expect(recorded.queries).toEqual([])
    const listed = await gh(fake, ["pr", "list", "--search", "is:open (a OR b)"])
    expect(listed).toEqual({ stdout: "7\tours\ty\tOPEN\t2026-01-03T00:00:00Z\n", stderr: "", exitCode: 0 })
  })

  test("approving is refused before any GitHub call", async () => {
    const [fake, recorded] = backend(() => noPullRequests)
    const result = await gh(fake, ["pr", "review", "7", "--approve"])
    expect(result.exitCode).toBe(1)
    expect(recorded.queries).toEqual([])
    expect(recorded.mutations).toEqual([])
  })
})

describe("gh pr checks", () => {
  const rollup = (contexts: unknown[]) => () => ({
    node: { statusCheckRollup: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts, pageInfo: { hasNextPage: false } } } } }] } },
  })
  const passed = {
    __typename: "CheckRun",
    name: "build",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:05Z",
    detailsUrl: "https://ci/build",
    checkSuite: { workflowRun: { event: "pull_request", workflow: { name: "CI" } } },
  }
  const lookup = { repository: { pullRequest: { id: "PR_7", number: 7, headRefName: "fix-login_bug" } } }

  test("exits 8 while a check is pending, failures first otherwise, rows as gh prints them", async () => {
    const pending = { ...passed, name: "lint", status: "IN_PROGRESS", conclusion: null, completedAt: null, detailsUrl: "https://ci/lint" }
    const [fake] = backend((q) => (q.includes("PullRequestByNumber") ? lookup : rollup([passed, pending])()))
    expect(await gh(fake, ["pr", "checks", "7"])).toEqual({
      stdout: "build\tpass\t1m5s\thttps://ci/build\t\nlint\tpending\t0\thttps://ci/lint\t\n",
      stderr: "",
      exitCode: 8,
    })

    const failed = { ...passed, name: "test", conclusion: "FAILURE", detailsUrl: "https://ci/test" }
    const [failing] = backend((q) => (q.includes("PullRequestByNumber") ? lookup : rollup([passed, failed])()))
    expect(await gh(failing, ["pr", "checks", "7"])).toEqual({
      stdout: "test\tfail\t1m5s\thttps://ci/test\t\nbuild\tpass\t1m5s\thttps://ci/build\t\n",
      stderr: "",
      exitCode: 1,
    })
  })
})

describe("gh api", () => {
  const json = (body: unknown, status = 200, extra: Array<[string, string]> = []): ApiResponse => ({
    status,
    headers: [["content-type", "application/json; charset=utf-8"], ...extra],
    body: JSON.stringify(body),
  })
  const apiBackend = (answer: (request: ApiRequest) => ApiResponse): [GhBackend, ApiRequest[]] => {
    const [fake] = backend(() => null)
    const sent: ApiRequest[] = []
    return [{ ...fake, api: async (request) => (sent.push(request), answer(request)) }, sent]
  }

  test("fields become a sorted query string for GET and grouped variables for graphql", async () => {
    const [fake, sent] = apiBackend(() => json({ data: {} }))
    await gh(fake, ["api", "-X", "GET", "search/issues", "-f", "q=repo:acme/widget is:open", "-F", "per_page=5", "-F", "labels[]=bug", "-F", "draft=false"])
    await gh(fake, ["api", "graphql", "-F", "owner={owner}", "-F", "n=7", "-f", "query=query($owner: String!, $n: Int!) { x }"])
    expect(sent).toEqual([
      { method: "GET", path: "search/issues?draft=false&labels%5B%5D=bug&per_page=5&q=repo%3Aacme%2Fwidget+is%3Aopen", headers: [["Accept", "*/*"]], body: null },
      {
        method: "POST",
        path: "graphql",
        headers: [["Content-Type", "application/json; charset=utf-8"], ["Accept", "*/*"]],
        body: '{"query":"query($owner: String!, $n: Int!) { x }","variables":{"n":7,"owner":"acme"}}',
      },
    ])
  })

  test("--paginate follows the Link header and prints the pages as one array", async () => {
    const next = "https://api.github.com/repositories/1/issues?per_page=100&page=2"
    const [fake, sent] = apiBackend((request) =>
      request.path === next ? json([{ n: 3 }]) : json([{ n: 1 }, { n: 2 }], 200, [["link", `<${next}>; rel="next", <${next}>; rel="last"`]]),
    )
    expect(await gh(fake, ["api", "--paginate", "repos/{owner}/{repo}/issues"])).toEqual({ stdout: '[{"n":1},{"n":2},{"n":3}]', stderr: "", exitCode: 0 })
    expect(sent.map((r) => r.path)).toEqual(["repos/acme/widget/issues?per_page=100", next])
  })

  test("an error prints GitHub's body, then what went wrong, and exits 1", async () => {
    const notFound = { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }
    const [missing] = apiBackend(() => json(notFound, 404))
    expect(await gh(missing, ["api", "repos/acme/nope"])).toEqual({ stdout: JSON.stringify(notFound), stderr: "gh: Not Found (HTTP 404)\n", exitCode: 1 })

    // GraphQL reports failures with HTTP 200; --jq is skipped so the errors stay visible.
    const failed = { data: null, errors: [{ message: "Field 'nope' doesn't exist on type 'Query'" }, { message: "second" }] }
    const [invalid] = apiBackend(() => json(failed))
    expect(await gh(invalid, ["api", "graphql", "-f", "query={ nope }", "--jq", ".data"])).toEqual({
      stdout: JSON.stringify(failed),
      stderr: "gh: Field 'nope' doesn't exist on type 'Query'\nsecond\n",
      exitCode: 1,
    })
  })
})

describe("argument parsing", () => {
  test("follows pflag: combined shorthands, attached values, CSV slices that accumulate, and --", () => {
    const parsed = parseFlags(["-dtTitle", "pos", "--label=a,\"b,c\"", "-l", "d", "--", "--not-a-flag"], [bool("draft", "d"), str("title", "t"), slice("label", "l")])
    expect(parsed.values.get("draft")).toBe(true)
    expect(parsed.values.get("title")).toBe("Title")
    expect(parsed.values.get("label")).toEqual(["a", "b,c", "d"])
    expect(parsed.args).toEqual(["pos", "--not-a-flag"])
  })
})

describe("shim requests", () => {
  const encode = (parts: Array<string | Uint8Array>) => {
    const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p))
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }

  test("decode arguments, the working directory and files, and refuse truncated bodies", () => {
    // "a✓" is four bytes in UTF-8.
    const body = encode(["kestrel-gh/1\0/w\x002\0pr\0view\x002\0-\x004\0/tmp/b.md\0-1\0", "a✓"])
    expect(decodeGhRequest(body)).toEqual({
      cwd: "/w",
      argv: ["pr", "view"],
      files: new Map([
        ["-", "a✓"],
        ["/tmp/b.md", null],
      ]),
    })
    expect(decodeGhRequest(body.subarray(0, body.length - 1))).toBeNull()
    expect(decodeGhRequest(encode(["kestrel-gh/2\0/w\x000\x000\0"]))).toBeNull()
  })
})

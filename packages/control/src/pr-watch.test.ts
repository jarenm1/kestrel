import { afterAll, describe, expect, mock, spyOn, test } from "bun:test"
import { BOX_USER_HEADER } from "@cloudagents/protocol"
import type { Env } from "./env"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
// The Worker imports the mocked module, so it must load after the mock is registered.
const worker = (await import("./index")).default

const TASK_ID = "task-1"
const REPO = "acme/app"
const pr = { number: 7, title: "Fix", html_url: "https://github.com/acme/app/pull/7", draft: false, user: { login: "octo" }, head: { ref: "fix", sha: "abc" }, base: { ref: "main" } }

/** GitHub answers for the repository and pull request lookups; no request leaves the test. */
const github = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
  const url = String(input)
  if (url.endsWith(`/repos/${REPO}`)) return Response.json({ full_name: REPO })
  if (url.endsWith(`/repos/${REPO}/pulls/${pr.number}`)) return Response.json(pr)
  throw new Error(`unexpected GitHub request ${url}`)
})

afterAll(() => {
  github.mockRestore()
})

/** The box's answer to `GET /api/tasks/:id`, set per test. */
let boxAnswer: { ok: boolean; status: number; body: string } = { ok: true, status: 200, body: "{}" }
const stub = {
  getUser: async (login: string) => (login === "octo" ? { login } : null),
  credentials: async () => ({ github: "gh-token" }),
  boxCall: async () => boxAnswer,
}
const env = {
  BOX_TOKEN: "relay-secret",
  HUB: { idFromName: () => "main", get: () => stub },
} as unknown as Env

const watch = (): Promise<Response> =>
  worker.fetch(new Request("https://app.example/box/automations/pr-watch", {
    method: "POST",
    headers: { authorization: "Bearer relay-secret", "content-type": "application/json", [BOX_USER_HEADER]: "octo" },
    body: JSON.stringify({ taskId: TASK_ID, repo: REPO, number: pr.number }),
  }), env)

const boxError = (status: number, tag: string) => ({ ok: false, status, body: JSON.stringify({ _tag: tag, message: "agent box is offline" }) })

describe("POST /box/automations/pr-watch: box failures", () => {
  test.each([
    [502, "BoxOffline"],
    [503, "BoxOffline"],
    [504, "BoxOffline"],
  ])("an offline box answering %i reaches the caller with its status and body", async (status, tag) => {
    boxAnswer = boxError(status, tag)
    const response = await watch()
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.json()).toEqual({ _tag: tag, message: "agent box is offline" })
  })

  test("a failed box answer with a non-JSON body is not labelled as JSON", async () => {
    boxAnswer = { ok: false, status: 502, body: "<html>bad gateway</html>" }
    const response = await watch()
    expect(response.status).toBe(502)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await response.json()).toEqual({ _tag: "BoxOffline", message: "agent box request failed" })
  })

  test("a failed box answer that is JSON but not an error shape is not forwarded", async () => {
    boxAnswer = { ok: false, status: 503, body: JSON.stringify({ unexpected: true }) }
    const response = await watch()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ _tag: "BoxOffline", message: "agent box request failed" })
  })

  test("a non-JSON box 404 is still a 404", async () => {
    boxAnswer = { ok: false, status: 404, body: "not found" }
    const response = await watch()
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ _tag: "NotFound", message: "agent box request failed" })
  })

  test("a thread the box does not have is still a 404", async () => {
    boxAnswer = { ok: false, status: 404, body: JSON.stringify({ _tag: "NotFound", message: "thread not found" }) }
    const response = await watch()
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ _tag: "NotFound", message: "thread not found" })
  })

  test("a successful box answer that is not JSON is a 502, not a 404", async () => {
    boxAnswer = { ok: true, status: 200, body: "<html>proxy error</html>" }
    const response = await watch()
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ _tag: "BadGateway", message: "invalid thread response" })
  })

  test("a successful box answer that is JSON but not a thread is a 502, not a 404", async () => {
    boxAnswer = { ok: true, status: 200, body: JSON.stringify({ unexpected: true }) }
    const response = await watch()
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ _tag: "BadGateway", message: "invalid thread response" })
  })
})

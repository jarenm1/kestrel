import { expect, test } from "bun:test"
import type { Env } from "./env"
import { handleGithubWebhook } from "./webhooks"

test("a replay completes PR close cleanup after delivery was recorded", async () => {
  const raw = JSON.stringify({ action: "closed", number: 12, repository: { full_name: "owner/repo" }, pull_request: {
    number: 12, title: "PR", html_url: "https://github.com/owner/repo/pull/12", draft: false,
    user: { login: "alice" }, head: { ref: "branch" }, base: { ref: "main" },
  } })
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))
  const signature = `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
  let attempts = 0
  const stub = {
    githubHook: () => ({ hookId: 1, secret: "secret" }),
    githubDelivery: () => ({ duplicate: attempts > 0, matched: 0 }),
    closePullRequestWatches: (id: string, repo: string, number: number) => {
      expect([id, repo, number]).toEqual(["delivery", "owner/repo", 12])
      if (++attempts === 1) throw new Error("interrupted")
      return []
    },
  }
  const env = { HUB: { idFromName: () => "main", get: () => stub } } as unknown as Env
  const request = () => new Request("https://example.test/webhooks/github", { method: "POST", body: raw, headers: {
    "x-github-hook-id": "1", "x-hub-signature-256": signature, "x-github-event": "pull_request", "x-github-delivery": "delivery",
  } })
  await expect(handleGithubWebhook(request(), env)).rejects.toThrow("interrupted")
  const response = await handleGithubWebhook(request(), env)
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ duplicate: true, matched: 0 })
  expect(attempts).toBe(2)
})

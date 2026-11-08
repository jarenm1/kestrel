import { describe, expect, mock, test } from "bun:test"
import { ControlPaths } from "@cloudagents/protocol"
import type { Env } from "./env"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default

const calls: { email: string; ip: string }[] = []
const stub = {
  addWaitlistSignup: async (email: string, ip: string) => {
    calls.push({ email, ip })
    if (email === "limited@example.com") return null
    return {
      email: email.toLowerCase(),
      createdAt: "2026-11-08T12:00:00.000Z",
      created: email !== "person@example.com",
    }
  },
}
const env = { HUB: { idFromName: () => "main", get: () => stub } } as unknown as Env
const request = (path: string, init?: RequestInit, host = "app.example") =>
  worker.fetch(new Request(`https://${host}${path}`, init), env)
const post = (body: unknown, headers: Record<string, string> = {}) =>
  request(ControlPaths.waitlist, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

describe("waitlist signup", () => {
  test("accepts a public signup without a session and passes the client IP to the Hub", async () => {
    calls.length = 0
    const response = await post({ email: "New@Example.com" }, { "cf-connecting-ip": "203.0.113.7" })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ email: "new@example.com", created: true })
    expect(calls).toEqual([{ email: "New@Example.com", ip: "203.0.113.7" }])
  })

  test("answers 200 for an email already on the list", async () => {
    const response = await post({ email: "person@example.com" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: false })
  })

  test("rejects invalid bodies and methods", async () => {
    expect((await post({ email: "not-an-email" })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await request(ControlPaths.waitlist)).status).toBe(405)
  })

  test("answers 429 when the Hub rate-limits the client", async () => {
    expect((await post({ email: "limited@example.com" })).status).toBe(429)
  })

  test("the marketing host serves the endpoint instead of redirecting /api to the app host", async () => {
    const response = await post({ email: "site@example.com" }, {}, "kestrel-agent.com")
    expect(response.status).toBe(201)
  })
})

import { describe, expect, mock, test } from "bun:test"
import { BOX_ID_HEADER, ControlPaths } from "@cloudagents/protocol"
import type { Env } from "./env"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const worker = (await import("./index")).default

const received: unknown[] = []
const stub = {
  managedBoxVerify: async (id: string, secret: string) => id === "managed" && secret === "managed-secret",
  recordToolFailures: async (report: unknown) => { received.push(report) },
  commonToolFailures: async (days: number) => ({ days, failures: [] }),
  session: async (id: string) => id === "operator" ? { login: "operator" } : id === "user" ? { login: "user" } : null,
}
const env = {
  BOX_TOKEN: "relay-secret",
  KESTREL_OPERATORS: "operator",
  HUB: { idFromName: () => "main", get: () => stub },
} as unknown as Env
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://app.example${path}`, init), env)
const report = JSON.stringify({ failures: [{ tool: "Read", signature: "failed", count: 1 }] })

describe("tool failure routes", () => {
  test("accepts relay and managed credentials, rejects invalid credentials and bodies", async () => {
    received.length = 0
    const send = (headers: Record<string, string>, body = report) => request(ControlPaths.boxToolFailures, { method: "POST", headers, body })
    expect((await send({ authorization: "Bearer relay-secret" })).status).toBe(204)
    expect((await send({ authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "managed" })).status).toBe(204)
    expect((await send({ authorization: "Bearer wrong", [BOX_ID_HEADER]: "managed" })).status).toBe(401)
    expect((await send({ authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "user-box" })).status).toBe(401)
    expect((await send({ authorization: "Bearer relay-secret" }, "{}" )).status).toBe(400)
    const oversized = JSON.stringify({ failures: Array.from({ length: 201 }, () => ({ tool: "Read", signature: "failed", count: 1 })) })
    expect((await send({ authorization: "Bearer relay-secret" }, oversized)).status).toBe(400)
    expect((await request(ControlPaths.boxToolFailures)).status).toBe(405)
    expect(received).toHaveLength(2)
  })

  test("restricts the list to operators and validates the method and window", async () => {
    const path = ControlPaths.fleetToolFailures
    expect((await request(path)).status).toBe(401)
    expect((await request(path, { headers: { cookie: "session=user" } })).status).toBe(404)
    const headers = { cookie: "session=operator" }
    expect((await request(path, { method: "POST", headers })).status).toBe(405)
    for (const days of ["0", "91", "1.5", "abc"]) expect((await request(`${path}?days=${days}`, { headers })).status).toBe(400)
    const response = await request(`${path}?days=30`, { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ days: 30, failures: [] })
  })
})

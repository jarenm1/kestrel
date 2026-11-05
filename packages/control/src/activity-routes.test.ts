import { describe, expect, mock, test } from "bun:test"
import {
  BOX_ID_HEADER,
  ControlPaths,
  MAX_ACTIVITY_CLOCK_SKEW_SECONDS,
  MAX_BOX_ACTIVITY_USERS,
  type BoxActivityReport,
  type FleetActivity,
} from "@cloudagents/protocol"
import type { Env } from "./env"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
// The Worker imports the mocked module, so it must load after the mock is registered.
const worker = (await import("./index")).default

const received: { boxId: string; report: BoxActivityReport }[] = []
const activity: FleetActivity = {
  windowSeconds: 300,
  staleAfterSeconds: 90,
  boxes: [{ boxId: "managed", receivedAt: "2026-11-04T12:00:00.000Z", users: [{ login: "alice", lastActiveAt: "2026-11-04T11:59:00.000Z" }] }],
}
const stub = {
  managedBoxVerify: async (id: string, secret: string) => id === "managed" && secret === "managed-secret",
  recordBoxActivity: async (boxId: string, report: BoxActivityReport) => {
    received.push({ boxId, report })
  },
  fleetActivity: async () => activity,
  session: async (id: string) => (id === "operator" ? { login: "operator" } : id === "user" ? { login: "user" } : null),
}
const env = {
  BOX_TOKEN: "relay-secret",
  KESTREL_OPERATORS: "operator",
  HUB: { idFromName: () => "main", get: () => stub },
} as unknown as Env
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://app.example${path}`, init), env)
const now = Date.now()
const at = (seconds: number): string => new Date(now + seconds * 1000).toISOString()
const snapshot = (users: { login: string; lastActiveAt: string }[]) => JSON.stringify({ users })

describe("box activity ingestion", () => {
  test("accepts only a managed box's own secret and a full snapshot", async () => {
    received.length = 0
    const send = (headers: Record<string, string>, body = snapshot([{ login: "alice", lastActiveAt: at(-60) }])) =>
      request(ControlPaths.boxActivity, { method: "POST", headers, body })
    const managed = { authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "managed" }

    expect((await send(managed)).status).toBe(204)
    expect((await send(managed, snapshot([]))).status).toBe(204)
    // The legacy shared relay token is not managed-box proof.
    expect((await send({ authorization: "Bearer relay-secret", [BOX_ID_HEADER]: "managed" })).status).toBe(401)
    expect((await send({ authorization: "Bearer wrong", [BOX_ID_HEADER]: "managed" })).status).toBe(401)
    expect((await send({ authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "user-box" })).status).toBe(401)
    expect((await send({ authorization: "Bearer managed-secret" })).status).toBe(401)
    expect((await send(managed, "{}")).status).toBe(400)
    expect((await request(ControlPaths.boxActivity)).status).toBe(405)
    expect(received).toHaveLength(2)
  })

  test("refuses future timestamps beyond the clock-skew allowance and more than the user cap", async () => {
    const managed = { authorization: "Bearer managed-secret", [BOX_ID_HEADER]: "managed" }
    const send = (body: string) => request(ControlPaths.boxActivity, { method: "POST", headers: managed, body })

    expect((await send(snapshot([{ login: "alice", lastActiveAt: at(MAX_ACTIVITY_CLOCK_SKEW_SECONDS) }]))).status).toBe(204)
    expect((await send(snapshot([{ login: "alice", lastActiveAt: at(MAX_ACTIVITY_CLOCK_SKEW_SECONDS + 60) }]))).status).toBe(400)

    const tooMany = snapshot(
      Array.from({ length: MAX_BOX_ACTIVITY_USERS + 1 }, (_, i) => ({ login: `user${i}`, lastActiveAt: at(-1) })),
    )
    expect((await send(tooMany)).status).toBe(400)
  })
})

describe("fleet activity read", () => {
  test("is operator-only", async () => {
    const path = ControlPaths.fleetActivity
    expect((await request(path)).status).toBe(401)
    expect((await request(path, { headers: { cookie: "session=user" } })).status).toBe(404)

    const headers = { cookie: "session=operator" }
    expect((await request(path, { method: "POST", headers })).status).toBe(405)
    const response = await request(path, { headers })
    expect(response.status).toBe(200)
  })
})

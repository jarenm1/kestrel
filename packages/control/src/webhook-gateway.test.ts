import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  acceptWebhook,
  claimDueDeliveries,
  ensureWebhookTables,
  settleDelivery,
  type WebhookOutcome,
  type WebhookRequest,
} from "./webhook-gateway"
import { ensureAutomationsTable, type AutomationsSql } from "./automations-table"

const NOW = Date.UTC(2025, 0, 1, 12, 0, 0)
const SECRET = "secret-1"
const enc = new TextEncoder()

let db: Database
let sql: AutomationsSql

type DeliveryRow = { status: string; error: string | null; nextAttemptAt: number; requestJson: string | null }

const delivery = (id: string) =>
  db
    .query<DeliveryRow, [string]>(
      "SELECT status, error, next_attempt_at AS nextAttemptAt, request_json AS requestJson FROM automation_deliveries WHERE id = ?",
    )
    .get(id)

const ok = (outcome: WebhookOutcome) => {
  if (!outcome.ok) throw new Error(`${outcome.tag}: ${outcome.message}`)
  return outcome
}

const hmac = async (secret: string, body: Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body))
  return "sha256=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")
}

const request = (overrides: Partial<WebhookRequest> = {}): WebhookRequest => ({
  automationId: "a1",
  authorization: `Bearer ${SECRET}`,
  signature: null,
  senderId: null,
  body: enc.encode('{"event":"ping"}'),
  ...overrides,
})

const addAutomation = (enabled = 1) =>
  db.run(
    `INSERT INTO automations (id, login, name, repo, prompt, model, enabled, trigger_json, next_run_at, created_at, updated_at,
                              webhook_secret, webhook_box_id, webhook_on_unavailable)
     VALUES ('a1', 'octo', 'Daily', NULL, 'Summarise the payload', NULL, ?, '{"_tag":"webhook"}', NULL, 'now', 'now',
             ?, NULL, 'retry')`,
    enabled,
    SECRET,
  )

beforeEach(() => {
  db = new Database(":memory:")
  sql = {
    exec: (query, ...bindings) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never }
    },
  }
  ensureAutomationsTable(sql)
  ensureWebhookTables(sql)
  addAutomation()
})

describe("acceptWebhook", () => {
  test("stores a delivery for a valid bearer and reports it accepted", async () => {
    const outcome = ok(await acceptWebhook(sql, NOW, request()))
    expect(outcome.created).toBe(true)
    expect(outcome.accepted.status).toBe("accepted")
    expect(outcome.accepted.duplicate).toBe(false)
    expect(delivery(outcome.accepted.id)?.status).toBe("accepted")
  })

  test("accepts a valid HMAC signature over the raw body", async () => {
    const body = enc.encode('{"event":"push"}')
    const signature = await hmac(SECRET, body)
    const outcome = await acceptWebhook(sql, NOW, request({ authorization: null, signature, body }))
    expect(outcome.ok).toBe(true)
  })

  test("refuses a wrong secret with 401 and stores nothing", async () => {
    const outcome = await acceptWebhook(sql, NOW, request({ authorization: "Bearer nope" }))
    expect(outcome).toMatchObject({ ok: false, status: 401 })
    expect(db.query("SELECT COUNT(*) AS n FROM automation_deliveries").get()).toEqual({ n: 0 })
  })

  test("refuses a signature made with the wrong secret", async () => {
    const body = enc.encode("{}")
    const signature = await hmac("other", body)
    const outcome = await acceptWebhook(sql, NOW, request({ authorization: null, signature, body }))
    expect(outcome).toMatchObject({ ok: false, status: 401 })
  })

  test("returns 404 for an unknown automation", async () => {
    const outcome = await acceptWebhook(sql, NOW, request({ automationId: "missing" }))
    expect(outcome).toMatchObject({ ok: false, status: 404 })
  })

  test("refuses a disabled automation with 409", async () => {
    db.run("UPDATE automations SET enabled = 0 WHERE id = 'a1'")
    const outcome = await acceptWebhook(sql, NOW, request())
    expect(outcome).toMatchObject({ ok: false, status: 409 })
  })

  test("answers a repeated sender id with the first delivery, whatever the body", async () => {
    const first = ok(await acceptWebhook(sql, NOW, request({ senderId: "evt-1" })))
    const repeat = ok(await acceptWebhook(sql, NOW, request({ senderId: "evt-1", body: enc.encode("{}") })))
    expect(repeat.created).toBe(false)
    expect(repeat.accepted.id).toBe(first.accepted.id)
    expect(repeat.accepted.duplicate).toBe(true)
    expect(db.query("SELECT COUNT(*) AS n FROM automation_deliveries").get()).toEqual({ n: 1 })
  })

  test("exhausts the failed-auth bucket after 60 bad credentials and answers 429", async () => {
    for (let i = 0; i < 60; i++) {
      const outcome = await acceptWebhook(sql, NOW, request({ authorization: "Bearer nope" }))
      expect(outcome).toMatchObject({ ok: false, status: 401 })
    }
    const limited = await acceptWebhook(sql, NOW, request({ authorization: "Bearer nope" }))
    expect(limited).toMatchObject({ ok: false, status: 429 })
    if (limited.ok) throw new Error("expected a refusal")
    expect(limited.retryAfter).toBeGreaterThan(0)
  })

  test("caps accepted deliveries per automation per minute at 30", async () => {
    for (let i = 0; i < 30; i++) ok(await acceptWebhook(sql, NOW, request()))
    const outcome = await acceptWebhook(sql, NOW, request())
    expect(outcome).toMatchObject({ ok: false, status: 429 })
  })
})

describe("claimDueDeliveries and settleDelivery", () => {
  test("claims an accepted delivery as delivering and settles a retry with 30 s backoff", async () => {
    const accepted = ok(await acceptWebhook(sql, NOW, request())).accepted
    const [claimed] = claimDueDeliveries(sql, NOW)
    expect(claimed?.id).toBe(accepted.id)
    expect(claimed?.attempts).toBe(1)
    expect(delivery(accepted.id)?.status).toBe("delivering")

    settleDelivery(sql, NOW, claimed!, { kind: "retry", error: "box offline", ambiguous: false })
    expect(delivery(accepted.id)).toMatchObject({ status: "retrying", nextAttemptAt: NOW + 30_000 })
  })

  test("marks a retry whose earlier attempt may have landed as ambiguous", async () => {
    const accepted = ok(await acceptWebhook(sql, NOW, request())).accepted
    const [claimed] = claimDueDeliveries(sql, NOW)
    settleDelivery(sql, NOW, claimed!, { kind: "retry", error: "timeout", ambiguous: true })
    expect(delivery(accepted.id)?.status).toBe("ambiguous")
  })

  test("drops the stored request when the run is delivered", async () => {
    const accepted = ok(await acceptWebhook(sql, NOW, request())).accepted
    const [claimed] = claimDueDeliveries(sql, NOW)
    settleDelivery(sql, NOW, claimed!, { kind: "delivered", taskId: "t1", runId: "r1" })
    expect(delivery(accepted.id)).toMatchObject({ status: "delivered", requestJson: null })
  })

  test("fails a delivery permanently after the attempt limit", async () => {
    const accepted = ok(await acceptWebhook(sql, NOW, request())).accepted
    let now = NOW
    for (let attempt = 1; attempt <= 10; attempt++) {
      const [claimed] = claimDueDeliveries(sql, now)
      expect(claimed?.attempts).toBe(attempt)
      settleDelivery(sql, now, claimed!, { kind: "retry", error: "box offline", ambiguous: false })
      now = delivery(accepted.id)?.nextAttemptAt ?? now
    }
    expect(delivery(accepted.id)).toMatchObject({ status: "failed" })
  })
})

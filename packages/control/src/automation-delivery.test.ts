import { Database } from "bun:sqlite"
import { expect, mock, test } from "bun:test"
import type { Env } from "./env"
import type { Hub as HubClass } from "./hub"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")

const setup = () => {
  const db = new Database(":memory:")
  let alarm: number | null = null
  const sql = { exec: (query: string, ...args: (string | number | null)[]) => {
    const rows = db.query(query).all(...args)
    return { toArray: () => rows as never[] }
  } }
  const ctx = {
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: {
      sql,
      transactionSync: <T>(work: () => T) => db.transaction(work)(),
      setAlarm: async (at: number) => { alarm = at },
      deleteAlarm: async () => { alarm = null },
    },
    getWebSockets: () => [],
  }
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, {} as Env)
  Object.assign(hub, { ctx, env: {} })
  return { hub, db, alarm: () => alarm }
}

test("a due schedule survives dispatch interruption and an unrelated edit", async () => {
  const { hub, db, alarm } = setup()
  const automation = await hub.createAutomation("octo", {
    name: "Daily", repo: null, prompt: "Work", trigger: { _tag: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  })
  const due = Date.now() - 1000
  db.run("UPDATE automations SET next_run_at = ? WHERE id = ?", due, automation.id)
  await hub.updateAutomation("octo", automation.id, { name: "Renamed" })
  expect(db.query("SELECT next_run_at AS at FROM automations").get()).toEqual({ at: due })
  const target = hub as unknown as { fire: (...args: unknown[]) => Promise<unknown> }
  target.fire = async () => { throw new Error("interrupted") }
  await expect(hub.alarm()).rejects.toThrow("interrupted")
  expect(db.query("SELECT count(*) AS n FROM automation_jobs").get()).toEqual({ n: 1 })
  expect(alarm()).not.toBeNull()
  let calls = 0
  target.fire = async () => { calls++; return {} }
  await hub.alarm()
  expect(calls).toBe(1)
  expect(db.query("SELECT count(*) AS n FROM automation_jobs").get()).toEqual({ n: 0 })
  expect((db.query("SELECT next_run_at AS at FROM automations").get() as { at: number }).at).toBeGreaterThan(Date.now())
})

test("webhook deduplication retains a queued job until dispatch", async () => {
  const { hub, db, alarm } = setup()
  await hub.createAutomation("octo", {
    name: "Review", repo: "octo/repo", prompt: "Review", trigger: { _tag: "github", events: ["pull_request.opened"] },
  })
  const event = { repo: "octo/repo", action: "opened", requestedReviewer: null, pr: { number: 1, baseRef: "main", draft: false } }
  expect(await hub.githubDelivery("delivery", event as never)).toEqual({ duplicate: false, matched: 1 })
  expect(await hub.githubDelivery("delivery", event as never)).toEqual({ duplicate: true, matched: 0 })
  expect(db.query("SELECT count(*) AS n FROM automation_jobs").get()).toEqual({ n: 1 })
  expect(alarm()).not.toBeNull()
  let calls = 0
  ;(hub as unknown as { fire: () => Promise<unknown> }).fire = async () => { calls++; return {} }
  await hub.alarm()
  expect(calls).toBe(1)
  expect(db.query("SELECT count(*) AS n FROM automation_jobs").get()).toEqual({ n: 0 })
})

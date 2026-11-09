import { Database } from "bun:sqlite"
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test"
import type { Automation } from "@cloudagents/protocol"
import type { Env } from "./env"
import type { PullRequestEvent } from "./github"
import type { Hub as HubClass } from "./hub"

// The Worker and Hub import `cloudflare:workers`, so the mock must be registered before either module loads. A static
// import cannot be ordered after `mock.module`, which is why the adapter is loaded dynamically.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { Hub } = await import("./hub")

const START = Date.parse("2026-01-01T00:00:00.000Z")
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A Hub over in-memory SQLite, its database, and the env used by allowlist checks. */
const newHub = (vars: Partial<Env> = {}) => {
  const db = new Database(":memory:")
  const sql = {
    exec: (query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  }
  const ctx = {
    blockConcurrencyWhile: (work: () => Promise<void>) => work(),
    storage: {
      sql,
      transactionSync: <T>(work: () => T) => work(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    getWebSockets: () => [],
    waitUntil: () => {},
  }
  const env = {
    ALLOWED_GITHUB_LOGINS: "octocat",
    DEV_SESSION_LOGIN: "dev",
    ...vars,
  } as unknown as Env
  const hub: HubClass = new Hub(ctx as unknown as DurableObjectState, env)
  Object.assign(hub, { ctx, env })
  return { hub, db, env }
}

const signIn = (hub: HubClass, login = "octocat", dev = false): string => {
  const id = `session-${login}-${dev ? "dev" : "github"}`
  hub.createSession(id, login, Date.now() + HOUR, dev)
  return id
}

const okBox = { ok: true, status: 200, body: JSON.stringify({ id: "task-1" }) }

afterEach(() => setSystemTime())

describe("OAuth state", () => {
  test("is read without consuming, consumed once after validation, and cannot be overwritten while live", () => {
    setSystemTime(new Date(START))
    const { hub } = newHub()
    expect(hub.createOAuthState("state-1", "login", "github", "/", Date.now() + 60_000)).toBe(true)
    // A caller-supplied nonce that collides with a live state is refused, not silently replaced.
    expect(hub.createOAuthState("state-1", "login", "github", "/other", Date.now() + 60_000)).toBe(false)
    expect(hub.readOAuthState("state-1")).toEqual({ kind: "login", provider: "github", returnTo: "/" })
    expect(hub.consumeOAuthState("state-1")).toEqual({ kind: "login", provider: "github", returnTo: "/" })
    expect(hub.readOAuthState("state-1")).toBeNull()
    expect(hub.consumeOAuthState("state-1")).toBeNull()
  })

  test("expires without being consumed by a read", () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    expect(hub.createOAuthState("state-2", "login", "github", "/", Date.now() - 1)).toBe(true)
    expect(hub.readOAuthState("state-2")).toBeNull()
    expect(db.query("SELECT count(*) AS n FROM oauth_states WHERE state = 'state-2'").get()).toEqual({ n: 0 })
  })
})

describe("pairing collection", () => {
  test("is pending, collected once, replayed only during the short grace", () => {
    setSystemTime(new Date(START))
    const { hub } = newHub()
    const session = signIn(hub)
    const started = hub.startPairing({ name: "box", url: "https://box.example" }, "https://app.example")
    expect(started).not.toBeNull()
    expect(hub.pollPairing(started!.pairingId)).toMatchObject({ status: "pending" })

    const approved = hub.approvePairing(session, started!.code.replace(/-/g, ""), {
      name: "box",
      url: "https://box.example",
      activate: false,
    })
    expect(approved.ok).toBe(true)

    const first = hub.pollPairing(started!.pairingId)
    expect(first).toMatchObject({ status: "approved", box: { id: expect.any(String) } })
    if (first === null || first.status !== "approved") throw new Error("expected the approved box")
    const secret = first.secret
    expect(secret.length).toBeGreaterThan(0)

    // A CLI that lost the answer gets the same box and secret inside the grace window.
    setSystemTime(new Date(START + 30_000))
    expect(hub.pollPairing(started!.pairingId)).toMatchObject({ status: "approved", secret })

    // After the grace the secret is no longer replayable.
    setSystemTime(new Date(START + 61_000))
    expect(hub.pollPairing(started!.pairingId)).toBeNull()
  })

  test("approval does not extend the TTL, and an expired code cannot be approved", () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    const session = signIn(hub)
    const started = hub.startPairing({}, "https://app.example")
    const expiresAt = Date.parse(started!.expiresAt)

    // Approve just before the original expiry; the pairing still expires on time rather than gaining a fresh TTL.
    setSystemTime(new Date(expiresAt - 1_000))
    expect(
      hub.approvePairing(session, started!.code.replace(/-/g, ""), { name: "box", url: "https://box.example", activate: false }).ok,
    ).toBe(true)
    setSystemTime(new Date(expiresAt + 1))
    expect(hub.pollPairing(started!.pairingId)).toBeNull()
    expect(
      hub.approvePairing(session, started!.code.replace(/-/g, ""), { name: "box", url: "https://box.example", activate: false }).ok,
    ).toBe(false)
    expect(db.query("SELECT used_at AS usedAt FROM box_pairings WHERE id = ?").get(started!.pairingId)).toEqual({
      usedAt: null,
    })
  })
})

describe("session capabilities", () => {
  test("signing out revokes preview sessions for the login", () => {
    setSystemTime(new Date(START))
    const { hub } = newHub()
    const session = signIn(hub)
    const token = hub.createPreviewSession("octocat", "task-1")
    expect(hub.previewSession(token)).toEqual({ login: "octocat", taskId: "task-1" })
    hub.deleteSession(session)
    expect(hub.previewSession(token)).toBeNull()
  })
})

const scheduleAutomation = async (hub: HubClass): Promise<Automation> =>
  hub.createAutomation("octocat", {
    name: "nightly",
    repo: null,
    prompt: "run",
    trigger: { _tag: "schedule", cron: "* * * * *", timezone: "UTC" },
    enabled: true,
  })

const pullRequestEvent = (): PullRequestEvent => ({
  action: "opened",
  repo: "acme/app",
  pr: {
    number: 7,
    title: "Fix",
    url: "https://github.com/acme/app/pull/7",
    draft: false,
    author: "octo",
    headRef: "fix",
    baseRef: "main",
  },
  requestedReviewer: null,
})

describe("automation fire intents", () => {
  test("a schedule claim is durable, advances next_run_at after claiming, and never repeats its run", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    const automation = await scheduleAutomation(hub)
    db.run("UPDATE automations SET next_run_at = ? WHERE id = ?", START - 1, automation.id)
    const box = spyOn(hub, "boxCall").mockResolvedValue(okBox)

    await hub.alarm()
    expect(box).toHaveBeenCalled()
    expect(db.query("SELECT status, task_id AS taskId FROM automation_runs WHERE automation_id = ?").all(automation.id)).toEqual([
      { status: "started", taskId: "task-1" },
    ])
    expect(db.query("SELECT fire_key AS fireKey, outcome FROM automation_fires WHERE automation_id = ?").all(automation.id)).toEqual([
      { fireKey: `schedule:${START - 1}`, outcome: "started" },
    ])
    const advanced = db.query("SELECT next_run_at AS nextRunAt FROM automations WHERE id = ?").get(automation.id) as {
      nextRunAt: number
    }
    expect(advanced.nextRunAt).toBeGreaterThan(START)

    // The same scheduled instant claimed again returns the existing fire and its run.
    db.run("UPDATE automations SET next_run_at = ? WHERE id = ?", START - 1, automation.id)
    await hub.alarm()
    expect(db.query("SELECT count(*) AS n FROM automation_runs WHERE automation_id = ?").get(automation.id)).toEqual({ n: 1 })
    expect(db.query("SELECT count(*) AS n FROM automation_fires WHERE automation_id = ?").get(automation.id)).toEqual({ n: 1 })
  })

  test("a webhook delivery and its fire are stored together, deduped, and drained by the alarm", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    await hub.createAutomation("octocat", {
      name: "review",
      repo: "acme/app",
      prompt: "review",
      trigger: { _tag: "github", events: ["pull_request.opened"] },
      enabled: true,
    })
    const box = spyOn(hub, "boxCall").mockResolvedValue(okBox)
    const event = pullRequestEvent()

    expect(await hub.githubDelivery("delivery-1", event)).toEqual({ duplicate: false, matched: 1 })
    // Recording the delivery and the fire intent is one unit: the dedupe row never exists without its fire.
    expect(db.query("SELECT count(*) AS n FROM webhook_deliveries").get()).toEqual({ n: 1 })
    expect(db.query("SELECT fire_key AS fireKey, outcome, started_at AS startedAt FROM automation_fires").all()).toEqual([
      { fireKey: "delivery:delivery-1", outcome: null, startedAt: null },
    ])
    expect(box).not.toHaveBeenCalled()

    expect(await hub.githubDelivery("delivery-1", event)).toEqual({ duplicate: true, matched: 0 })
    expect(db.query("SELECT count(*) AS n FROM automation_fires").get()).toEqual({ n: 1 })

    await hub.alarm()
    expect(box).toHaveBeenCalledTimes(2)
    expect(db.query("SELECT outcome FROM automation_fires").all()).toEqual([{ outcome: "started" }])
    expect(db.query("SELECT count(*) AS n FROM automation_runs").get()).toEqual({ n: 1 })
  })

  test("a claim that never started is reclaimed, and a repeated claim is bounded", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    const box = spyOn(hub, "boxCall").mockResolvedValue(okBox)
    db.run(
      `INSERT INTO automation_fires (id, automation_id, fire_key, reason, claimed_at)
       VALUES ('fire-ok', 'gone', 'schedule:1', 'schedule', ?)`,
      START - 1,
    )
    db.run(
      `INSERT INTO automation_fires (id, automation_id, fire_key, reason, claimed_at, attempts)
       VALUES ('fire-stuck', 'gone', 'schedule:2', 'schedule', ?, 5)`,
      START - 1,
    )
    await hub.alarm()
    expect(db.query("SELECT id, outcome FROM automation_fires ORDER BY id").all()).toEqual([
      { id: "fire-ok", outcome: "failed" },
      { id: "fire-stuck", outcome: "failed" },
    ])
    // The stuck claim was failed without another box call; the reclaimable one reached the missing-automation check.
    expect(box).not.toHaveBeenCalled()
  })

  test("settled fires are pruned after the dedupe window, while a queued fire stays", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    spyOn(hub, "boxCall").mockResolvedValue(okBox)
    db.run(
      `INSERT INTO automation_fires (id, automation_id, fire_key, reason, claimed_at, started_at, outcome)
       VALUES ('old', 'gone', 'delivery:old', 'github', ?, ?, 'started')`,
      START - DAY - 1,
      START - DAY - 1,
    )
    db.run(
      `INSERT INTO automation_fires (id, automation_id, fire_key, reason, claimed_at)
       VALUES ('queued', 'gone', 'delivery:new', 'github', ?)`,
      START,
    )
    await hub.alarm()
    expect(db.query("SELECT id FROM automation_fires ORDER BY id").all()).toEqual([{ id: "queued" }])
  })
})

describe("PR activity retry bound", () => {
  const queue = (db: Database, rowid = "d1", status = "review"): void => {
    db.run("INSERT INTO pr_watches (login, task_id, repo, pr_number) VALUES ('octocat', 'task-1', 'acme/app', 7)")
    db.run(
      `INSERT INTO pr_activity_queue (login, task_id, repo, pr_number, kind, delivery_id, due_at)
       VALUES ('octocat', 'task-1', 'acme/app', 7, ?, ?, ?)`,
      status,
      rowid,
      START,
    )
  }

  test("backs off with a cap, then drops the event after the fifth failure", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    const box = spyOn(hub, "boxCall").mockResolvedValue({ ok: false, status: 500, body: "{}" })
    const error = spyOn(console, "error").mockImplementation(() => {})
    queue(db)
    try {
      const delays: number[] = []
      for (let attempt = 1; attempt <= 5; attempt++) {
        setSystemTime(new Date(START + delays.reduce((sum, d) => sum + d, 0)))
        const before = Date.now()
        await hub.alarm()
        const row = db.query("SELECT attempts, due_at AS dueAt FROM pr_activity_queue").get() as
          | { attempts: number; dueAt: number }
          | null
        if (row === null) break
        delays.push(row.dueAt - before)
      }
      expect(box).toHaveBeenCalledTimes(5)
      expect(db.query("SELECT count(*) AS n FROM pr_activity_queue").get()).toEqual({ n: 0 })
      expect(delays).toEqual([60_000, 120_000, 240_000, 480_000])
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0]?.[0])).toContain("after 5 attempts")
    } finally {
      error.mockRestore()
    }
  })

  test("a newer activity event restarts the retry budget", async () => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    queue(db, "old-delivery")
    db.run("UPDATE pr_activity_queue SET attempts = 4")
    expect(
      await hub.githubActivity("new-delivery", { repo: "acme/app", numbers: [7], kind: "review" }),
    ).toEqual({ duplicate: false, queued: 1 })
    expect(
      db.query("SELECT delivery_id AS deliveryId, attempts FROM pr_activity_queue").get(),
    ).toEqual({ deliveryId: "new-delivery", attempts: 0 })
  })

  test.each([400, 401, 403])("a permanent %i answer ends the queued activity immediately", async (status) => {
    setSystemTime(new Date(START))
    const { hub, db } = newHub()
    spyOn(hub, "boxCall").mockResolvedValue({ ok: false, status, body: "{}" })
    const error = spyOn(console, "error").mockImplementation(() => {})
    queue(db)
    try {
      await hub.alarm()
      expect(db.query("SELECT count(*) AS n FROM pr_activity_queue").get()).toEqual({ n: 0 })
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })
})

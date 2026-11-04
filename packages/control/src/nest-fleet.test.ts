import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  NEST_ENROLL_TOKEN_TTL_MS,
  NEST_LEASE_MS,
  type NestControlFrame,
  type NestHostCapacity,
  type NestHostCommand,
  type NestVmReport,
} from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"
import { NEST_STANDARD_LIMITS } from "./nest-control"
import { NestFleet, type NestHello, type NestLink } from "./nest-fleet"
import { ensureNestTables } from "./nest-table"

const GiB = 1024 * 1024 * 1024
const MINUTE = 60_000
const DOMAIN = "nest.example.com"

let db: Database
let sql: FleetSql
let now: number
let sent: { hostId: string; frame: NestControlFrame }[]
let connected: Set<string>
let fleet: NestFleet

const sqlOver = (database: Database): FleetSql => ({
  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) {
    const rows = database.query(query).all(...bindings) as T[]
    return { toArray: () => rows }
  },
})

const link: NestLink = {
  send(hostId, frame) {
    if (!connected.has(hostId)) return false
    sent.push({ hostId, frame })
    return true
  },
  connected: (hostId) => connected.has(hostId),
}

const capacityOf = (freeGiB: number): NestHostCapacity => ({
  vcpus: 8,
  vcpusPlugged: 0,
  memoryBytes: 16 * GiB,
  memoryPluggedBytes: 16 * GiB - freeGiB * GiB,
  diskFreeBytes: 10 * GiB,
  diskReservedBytes: 0,
  gpus: [],
  running: 0,
  suspended: 0,
})

const hello = async (hostId: string, vms: NestVmReport[] = [], results: NestHello["results"] = []) => {
  connected.add(hostId)
  await fleet.hello({ hostId, slug: `slug-${hostId}`, agentVersion: "test", imageId: "image-1", capacity: capacityOf(8), vms, results })
}

const disconnect = (hostId: string) => {
  connected.delete(hostId)
  fleet.hostDisconnected(hostId)
}

const addUser = (login: string) => {
  db.run("INSERT INTO users (login, name, avatar_url) VALUES (?, ?, '')", login, login)
}

const addBox = (login: string, boxId: string) => {
  db.run(
    "INSERT INTO user_boxes (id, login, name, url, secret, created_at) VALUES (?, ?, ?, '', ?, '')",
    boxId,
    login,
    boxId,
    `${boxId}-secret`,
  )
}

const placeBox = async (login: string, boxId: string) => {
  addBox(login, boxId)
  const target = fleet.placement()
  if (target === null) throw new Error("no host to place the box on")
  await fleet.createBox(boxId, login, target, NEST_STANDARD_LIMITS)
}

const commandsTo = (hostId: string): { commandId: string; command: NestHostCommand }[] =>
  sent.flatMap(({ hostId: to, frame }) =>
    to === hostId && frame._tag === "command" ? [{ commandId: frame.commandId, command: frame.command }] : [],
  )

const lastCommand = <T extends NestHostCommand["_tag"]>(hostId: string, tag: T) => {
  const found = commandsTo(hostId)
    .filter((entry) => entry.command._tag === tag)
    .at(-1)
  if (found === undefined) throw new Error(`no ${tag} command sent to ${hostId}`)
  return found as { commandId: string; command: Extract<NestHostCommand, { _tag: T }> }
}

const vmReport = (
  boxId: string,
  vmId: string,
  ownerEpoch: number,
  state: NestVmReport["state"],
  overrides: Partial<NestVmReport> = {},
): NestVmReport => ({
  boxId,
  vmId,
  userId: "alice",
  ownerEpoch,
  state,
  since: now,
  imageId: "image-1",
  vcpus: state === "running" ? 4 : 0,
  memoryBytes: state === "running" ? 8 * GiB : 0,
  gpus: [],
  diskBytes: 0,
  volumeRef: null,
  backedUpAt: null,
  limits: NEST_STANDARD_LIMITS,
  ...overrides,
})

const userBoxUrl = (boxId: string): string | undefined =>
  db.query<{ url: string }, [string]>("SELECT url FROM user_boxes WHERE id = ?").get(boxId)?.url

/** A box created on host-a and reported running: the common starting point. */
const runningBox = async (boxId = "box-1") => {
  await hello("host-a")
  await placeBox("alice", boxId)
  const create = lastCommand("host-a", "create")
  fleet.result("host-a", create.commandId, true, null, vmReport(boxId, create.command.vmId, 1, "running"))
  return create.command.vmId
}

beforeEach(() => {
  db = new Database(":memory:")
  sql = sqlOver(db)
  db.run("CREATE TABLE users (login TEXT PRIMARY KEY, name TEXT, avatar_url TEXT NOT NULL, active_box_id TEXT)")
  db.run(
    "CREATE TABLE user_boxes (id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL)",
  )
  ensureNestTables(sql)
  now = Date.UTC(2025, 0, 1)
  sent = []
  connected = new Set()
  fleet = new NestFleet(sql, link, DOMAIN, () => now)
  addUser("alice")
  addUser("bob")
})

describe("creating a box", () => {
  test("sends a create with the public URL and an enrollment token that enrolls the box", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const { command } = lastCommand("host-a", "create")
    expect(command.publicUrl).toBe("https://box-1.slug-host-a.nest.example.com")
    expect(command.enrollToken).toMatch(/^[0-9a-f]{64}$/)

    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toEqual({ secret: "box-1-secret" })
    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toEqual({ secret: "box-1-secret" })
    fleet.markEnrolled("box-1")
    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toBeNull()
  })

  test("refuses a wrong enrollment token, and the right one once it has expired", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const { command } = lastCommand("host-a", "create")
    expect(await fleet.enroll({ boxId: "box-1", token: "0".repeat(64) })).toBeNull()
    now += NEST_ENROLL_TOKEN_TTL_MS
    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toBeNull()
  })

  test("a create resent after the host reconnects keeps its command id and gets a fresh token", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const first = lastCommand("host-a", "create")
    await hello("host-a")
    const resent = lastCommand("host-a", "create")
    expect(resent.commandId).toBe(first.commandId)
    expect(resent.command.enrollToken).not.toBe(first.command.enrollToken)
    expect(await fleet.enroll({ boxId: "box-1", token: first.command.enrollToken })).toBeNull()
    expect(await fleet.enroll({ boxId: "box-1", token: resent.command.enrollToken })).toEqual({ secret: "box-1-secret" })
  })

  test("a create has no deadline; a failed create leaves the box provisioning", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    expect(fleet.nextDeadline()).toBeNull()
    const create = lastCommand("host-a", "create")
    fleet.result("host-a", create.commandId, false, "disk full", undefined)
    const status = fleet.statusesOf("alice").get("box-1")
    expect(status?.state).toBe("provisioning")
    expect(status?.pending).toBeNull()
  })
})

describe("VM reports and epochs", () => {
  test("a running report is what the owner sees", async () => {
    await runningBox()
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "running", vcpus: 4, pending: null })
  })

  test("a copy left at an older epoch on another host is evicted when it reports", async () => {
    const firstVm = await runningBox()
    fleet.vm("host-a", vmReport("box-1", firstVm, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    disconnect("host-a")
    await hello("host-b")
    fleet.wakeRequest("host-b", "box-1")

    const resume = lastCommand("host-b", "resume")
    expect(resume.command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
    expect(resume.command.vmId).not.toBe(firstVm)
    expect(userBoxUrl("box-1")).toBe("https://box-1.slug-host-b.nest.example.com")

    await hello("host-a", [vmReport("box-1", firstVm, 1, "running")])
    expect(lastCommand("host-a", "evict").command).toEqual({ _tag: "evict", boxId: "box-1", ownerEpoch: 1 })
  })

  test("a suspended box resumes on the same host with the same epoch and VM id", async () => {
    const vmId = await runningBox()
    fleet.suspend("alice", "box-1")
    const suspend = lastCommand("host-a", "suspend")
    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))

    expect(fleet.resume("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "resume").command).toMatchObject({ ownerEpoch: 1, vmId })
  })

  test("a resume waits for its host to reconnect, then goes out", async () => {
    const vmId = await runningBox()
    fleet.suspend("alice", "box-1")
    const suspend = lastCommand("host-a", "suspend")
    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))

    disconnect("host-a")
    fleet.resume("alice", "box-1")
    expect(commandsTo("host-a").some((entry) => entry.command._tag === "resume")).toBe(false)

    await hello("host-a")
    expect(lastCommand("host-a", "resume").command).toMatchObject({ ownerEpoch: 1, vmId })
  })

  test("a host may wake only the suspended boxes it holds", async () => {
    const vmId = await runningBox()
    fleet.suspend("alice", "box-1")
    const suspend = lastCommand("host-a", "suspend")
    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))
    await hello("host-b")

    const before = sent.length
    fleet.wakeRequest("host-b", "box-1")
    expect(sent.length).toBe(before)
  })

  test("a parked box waits for a host with room, then is placed there", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    disconnect("host-a")
    fleet.wakeRequest("host-a", "box-1")
    expect(sent.some((entry) => entry.frame._tag === "command" && entry.frame.command._tag === "resume")).toBe(false)

    await hello("host-c")
    expect(lastCommand("host-c", "resume").command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
  })

  test("limits set on a parked box are sent with its next resume, not to a host now", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    const bigger = { ...NEST_STANDARD_LIMITS, maxVcpus: 2 }

    const before = commandsTo("host-a").length
    expect(fleet.setLimits("alice", "box-1", bigger)).toEqual({ ok: true, value: null })
    expect(commandsTo("host-a").length).toBe(before)

    fleet.wakeRequest("host-a", "box-1")
    expect(lastCommand("host-a", "resume").command).toMatchObject({ limits: bigger })
  })

  test("a host reporting limits other than the box's is told the box's limits on reconnect", async () => {
    const vmId = await runningBox()
    await hello("host-a", [vmReport("box-1", vmId, 1, "running", { limits: { ...NEST_STANDARD_LIMITS, maxVcpus: 2 } })])
    expect(lastCommand("host-a", "setLimits").command).toMatchObject({ limits: NEST_STANDARD_LIMITS })
  })
})

describe("owner commands", () => {
  test("a box another user owns is not found", async () => {
    await runningBox()
    expect(fleet.resume("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
    expect(fleet.suspend("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
    expect(fleet.destroy("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
  })

  test("a second command while one is in flight is refused", async () => {
    await runningBox()
    expect(fleet.suspend("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(fleet.suspend("alice", "box-1")).toMatchObject({ ok: false, status: 409 })
  })

  test("an unanswered command is dropped at its deadline", async () => {
    await runningBox()
    fleet.suspend("alice", "box-1")
    expect(fleet.nextDeadline()).toBe(now + 10 * MINUTE)

    fleet.expire(now + 10 * MINUTE - 1)
    expect(fleet.suspend("alice", "box-1")).toMatchObject({ ok: false, status: 409 })

    fleet.expire(now + 10 * MINUTE)
    expect(fleet.suspend("alice", "box-1")).toEqual({ ok: true, value: null })
  })

  test("a destroyed box is forgotten once its host confirms", async () => {
    await runningBox()
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    const destroy = lastCommand("host-a", "destroy")
    fleet.result("host-a", destroy.commandId, true, null, undefined)

    expect(fleet.statusesOf("alice").has("box-1")).toBe(false)
    expect(fleet.isNestBox("box-1")).toBe(false)
    expect(userBoxUrl("box-1")).toBeUndefined()
  })

  test("a destroy the host refuses keeps the box", async () => {
    await runningBox()
    fleet.destroy("alice", "box-1")
    const destroy = lastCommand("host-a", "destroy")
    fleet.result("host-a", destroy.commandId, false, "volume busy", undefined)

    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "running", pending: null })
  })

  test("setting limits on a running box sends them to its host", async () => {
    await runningBox()
    const bigger = { ...NEST_STANDARD_LIMITS, maxVcpus: 2 }
    expect(fleet.setLimits("alice", "box-1", bigger)).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "setLimits").command).toMatchObject({ limits: bigger })
  })
})

describe("leases", () => {
  test("a hello and a capacity report each renew the host's lease", async () => {
    await hello("host-a")
    const leaseTo = (hostId: string) =>
      sent.flatMap(({ hostId: to, frame }) => (to === hostId && frame._tag === "lease" ? [frame.validUntil] : [])).at(-1)
    expect(leaseTo("host-a")).toBe(now + NEST_LEASE_MS)

    now += MINUTE
    await fleet.capacity("host-a", capacityOf(8))
    expect(leaseTo("host-a")).toBe(now + NEST_LEASE_MS)
  })
})

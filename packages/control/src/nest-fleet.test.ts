import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  NEST_ENROLL_TOKEN_TTL_MS,
  NEST_LAPSE_REFUSAL,
  NEST_LEASE_MS,
  type NestControlFrame,
  type NestHostCapacity,
  type NestHostCommand,
  type NestVmReport,
} from "@cloudagents/protocol"
import type { FleetSql } from "./fleet-table"
import { MAX_LAPSE_RETRIES, NEST_STANDARD_LIMITS } from "./nest-control"
import { NestFleet, type NestLink } from "./nest-fleet"
import { ensureNestTables } from "./nest-table"

const GiB = 1024 * 1024 * 1024
const MINUTE = 60_000
const DOMAIN = "nest.example.com"

let db: Database
let sql: FleetSql
let now: number
let sent: { hostId: string; frame: NestControlFrame }[]
let connected: Set<string>
let closing: Set<string>
let fleet: NestFleet

const sqlOver = (database: Database): FleetSql => ({
  exec<T extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) {
    const rows = database.query(query).all(...bindings) as T[]
    return { toArray: () => rows }
  },
})

const link: NestLink = {
  send(hostId, frame) {
    if (!connected.has(hostId) || closing.has(hostId)) return false
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

const hello = async (hostId: string, vms: NestVmReport[] = [], freeGiB = 8) => {
  connected.add(hostId)
  await fleet.hello({ hostId, slug: `slug-${hostId}`, agentVersion: "test", imageId: "image-1", capacity: capacityOf(freeGiB) })
  if (vms.length > 0) fleet.inventory(hostId, vms, true)
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
  const enroll = await fleet.mintEnrollToken()
  const target = fleet.placement(null)
  if (target === null) throw new Error("no host to place the box on")
  db.run("UPDATE user_boxes SET url = ? WHERE id = ?", `https://${boxId}.${target.slug}.${DOMAIN}`, boxId)
  fleet.createBox(boxId, login, target, NEST_STANDARD_LIMITS, enroll)
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
  closing = new Set()
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
    expect(command.enrollToken).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toEqual({ secret: "box-1-secret" })
    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toEqual({ secret: "box-1-secret" })
    fleet.markEnrolled("box-1")
    expect(await fleet.enroll({ boxId: "box-1", token: command.enrollToken })).toBeNull()
  })

  test("refuses a wrong enrollment token, and the right one once it has expired", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const { command } = lastCommand("host-a", "create")
    expect(await fleet.enroll({ boxId: "box-1", token: "0".repeat(43) })).toBeNull()
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

  test("a create resent after the box enrolled carries a token that enrolls nothing", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const first = lastCommand("host-a", "create")
    expect(await fleet.enroll({ boxId: "box-1", token: first.command.enrollToken })).toEqual({ secret: "box-1-secret" })
    fleet.markEnrolled("box-1")
    await hello("host-a")
    const resent = lastCommand("host-a", "create")
    expect(resent.commandId).toBe(first.commandId)
    expect(await fleet.enroll({ boxId: "box-1", token: resent.command.enrollToken })).toBeNull()
  })

  test("a resend the link refuses keeps the previous enrollment token usable", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const first = lastCommand("host-a", "create")
    const before = commandsTo("host-a").length
    closing.add("host-a")
    await hello("host-a")
    closing.delete("host-a")
    expect(commandsTo("host-a")).toHaveLength(before)
    expect(await fleet.enroll({ boxId: "box-1", token: first.command.enrollToken })).toEqual({ secret: "box-1-secret" })
  })

  test("a resume the link refuses keeps the previous enrollment token usable", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const first = lastCommand("host-a", "create")
    fleet.result("host-a", first.commandId, true, null, vmReport("box-1", first.command.vmId, 1, "running"))
    fleet.park("alice", "box-1")
    const park = lastCommand("host-a", "park")
    fleet.result("host-a", park.commandId, true, null, vmReport("box-1", first.command.vmId, 1, "parked", { volumeRef: "vol-1" }))
    closing.add("host-a")
    expect(await fleet.resume("alice", "box-1")).toEqual({ ok: true, value: null })
    closing.delete("host-a")
    expect(await fleet.enroll({ boxId: "box-1", token: first.command.enrollToken })).toEqual({ secret: "box-1-secret" })
  })

  test("a host with room for one boot has none left once a create is on its way", async () => {
    await hello("host-a", [], 2)
    await placeBox("alice", "box-1")
    expect(fleet.placement(null)).toBeNull()
  })

  test("a create the host refuses leaves the box failed, and the owner can delete it", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const create = lastCommand("host-a", "create")
    fleet.result("host-a", create.commandId, false, "disk full", undefined)
    expect(fleet.nextDeadline()).toBeNull()
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "provisioning", failed: true, pending: null })
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "destroy").command).toMatchObject({ boxId: "box-1" })
  })

  test("a failed create whose VM report is still provisioning stays failed", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const create = lastCommand("host-a", "create")
    fleet.result("host-a", create.commandId, false, "disk full", vmReport("box-1", create.command.vmId, 1, "provisioning"))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "provisioning", failed: true, pending: null })
  })

  test("a create that never gets an answer is marked failed at its deadline, and the owner can delete it", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    expect(fleet.nextDeadline()).toBe(now + 15 * MINUTE)

    await fleet.expire(now + 15 * MINUTE)
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "provisioning", failed: true, pending: null })
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "destroy").command).toMatchObject({ boxId: "box-1" })
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
    await hello("host-a", [], 1.25)
    await hello("host-b", [], 9)
    await fleet.wakeRequest("host-a", "box-1")

    const resume = lastCommand("host-b", "resume")
    expect(resume.command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
    expect(resume.command.vmId).not.toBe(firstVm)
    expect(userBoxUrl("box-1")).toBe("https://box-1.slug-host-b.nest.example.com")

    const stale = vmReport("box-1", firstVm, 1, "running")
    await hello("host-a", [stale])
    const evict = lastCommand("host-a", "evict").command
    expect(evict).toEqual({ _tag: "evict", boxId: "box-1", ownerEpoch: 2 })
    // The host's `evict` refuses an epoch that is not strictly newer than the copy it holds; the control plane's
    // epoch is newer than the stale report's, so the host accepts it.
    expect(evict.ownerEpoch).toBeGreaterThan(stale.ownerEpoch)
  })

  test("inventory evicts a stale copy only once the host's last chunk arrives", async () => {
    const firstVm = await runningBox()
    fleet.vm("host-a", vmReport("box-1", firstVm, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await hello("host-a", [], 1.25)
    await hello("host-b", [], 9)
    await fleet.wakeRequest("host-a", "box-1")

    const stale = vmReport("box-1", firstVm, 1, "running")
    fleet.inventory("host-a", [stale], false)
    expect(commandsTo("host-a").some((entry) => entry.command._tag === "evict")).toBe(false)
    fleet.inventory("host-a", [], true)
    const evict = lastCommand("host-a", "evict").command
    expect(evict).toEqual({ _tag: "evict", boxId: "box-1", ownerEpoch: 2 })
    expect(evict.ownerEpoch).toBeGreaterThan(stale.ownerEpoch)
  })

  test("a live report after hello is not overwritten by an older inventory chunk", async () => {
    const vmId = await runningBox()
    await hello("host-a")
    fleet.inventory("host-a", [vmReport("box-1", vmId, 1, "running")], false)
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "suspended"))
    fleet.inventory("host-a", [], true)
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "suspended" })
  })

  test("a suspended box resumes on the same host with the same epoch and VM id", async () => {
    const vmId = await runningBox()
    fleet.suspend("alice", "box-1")
    const suspend = lastCommand("host-a", "suspend")
    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))

    expect(await fleet.resume("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "resume").command).toMatchObject({ ownerEpoch: 1, vmId })
  })

  test("a resume waits for its host to reconnect, then goes out", async () => {
    const vmId = await runningBox()
    fleet.suspend("alice", "box-1")
    const suspend = lastCommand("host-a", "suspend")
    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))

    disconnect("host-a")
    await fleet.resume("alice", "box-1")
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
    await fleet.wakeRequest("host-b", "box-1")
    expect(sent.length).toBe(before)
  })

  test("a parked box waits for a host with room, then is placed there", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    disconnect("host-a")
    await fleet.wakeRequest("host-a", "box-1")
    expect(sent.some((entry) => entry.frame._tag === "command" && entry.frame.command._tag === "resume")).toBe(false)

    await hello("host-c")
    expect(lastCommand("host-c", "resume").command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
  })

  test("a parked box is woken only by the host its URL names", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await hello("host-b")

    await fleet.wakeRequest("host-b", "box-1")
    expect(sent.some((entry) => entry.frame._tag === "command" && entry.frame.command._tag === "resume")).toBe(false)

    await fleet.wakeRequest("host-a", "box-1")
    expect(lastCommand("host-a", "resume").command).toMatchObject({ ownerEpoch: 2 })
  })

  test("a parked box resumes on the host its request reached while that host has room, even when another has more", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await hello("host-b", [], 12)

    await fleet.wakeRequest("host-a", "box-1")
    expect(lastCommand("host-a", "resume").command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
    expect(userBoxUrl("box-1")).toBe("https://box-1.slug-host-a.nest.example.com")
  })

  test("a parked box moves to another host only when the host its request reached lacks room", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await hello("host-a", [], 1.25)
    await hello("host-b", [], 9)

    await fleet.wakeRequest("host-a", "box-1")
    expect(lastCommand("host-b", "resume").command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
    expect(userBoxUrl("box-1")).toBe("https://box-1.slug-host-b.nest.example.com")
  })

  test("a parked box's destroy that times out releases its host, so the retry goes to another connected host", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    disconnect("host-a")
    await hello("host-b")
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-b", "destroy").command).toMatchObject({ ownerEpoch: 1 })

    await fleet.expire(now + 20 * MINUTE)
    disconnect("host-b")
    await hello("host-c")
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(lastCommand("host-c", "destroy").command).toMatchObject({ ownerEpoch: 1 })
  })

  test("a resume the host never answers is sent again at its deadline, so the parked box is not left waiting", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    expect(await fleet.resume("alice", "box-1")).toEqual({ ok: true, value: null })
    const first = lastCommand("host-a", "resume")

    await fleet.expire(now + 10 * MINUTE)
    const second = lastCommand("host-a", "resume")
    expect(second.commandId).not.toBe(first.commandId)
    expect(second.command).toMatchObject({ ownerEpoch: 2, vmId: first.command.vmId, volumeRef: "vol-1" })
  })

  test("parked boxes woken in one wake loop are spread, so a host is not booked past its room", async () => {
    const vm1 = await runningBox("box-1")
    fleet.vm("host-a", vmReport("box-1", vm1, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await placeBox("alice", "box-2")
    const create = lastCommand("host-a", "create")
    fleet.result("host-a", create.commandId, true, null, vmReport("box-2", create.command.vmId, 1, "parked", { volumeRef: "vol-2", backedUpAt: now }))
    disconnect("host-a")
    await fleet.wakeRequest("host-a", "box-1")
    await fleet.wakeRequest("host-a", "box-2")

    // Host-b has 2 GiB free: room for one boot (1 GiB plus 512 MiB headroom), not for two.
    await hello("host-b", [], 2)
    expect(commandsTo("host-b").filter((entry) => entry.command._tag === "resume")).toHaveLength(1)
    expect([...fleet.statusesOf("alice").values()].filter((status) => status.pending === "resume")).toHaveLength(1)
  })

  test("limits set on a parked box are sent with its next resume, not to a host now", async () => {
    const vmId = await runningBox()
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    const bigger = { ...NEST_STANDARD_LIMITS, maxVcpus: 2 }

    const before = commandsTo("host-a").length
    expect(fleet.setLimits("alice", "box-1", bigger)).toEqual({ ok: true, value: null })
    expect(commandsTo("host-a").length).toBe(before)

    await fleet.wakeRequest("host-a", "box-1")
    expect(lastCommand("host-a", "resume").command).toMatchObject({ limits: bigger })
  })

  test("a host reporting limits other than the box's is told the box's limits on reconnect", async () => {
    const vmId = await runningBox()
    await hello("host-a", [vmReport("box-1", vmId, 1, "running", { limits: { ...NEST_STANDARD_LIMITS, maxVcpus: 2 } })])
    expect(lastCommand("host-a", "setLimits").command).toMatchObject({ limits: NEST_STANDARD_LIMITS })
  })

  test("reconnect reconciles limits against the latest live report during inventory", async () => {
    const vmId = await runningBox()
    await hello("host-a")
    fleet.inventory("host-a", [vmReport("box-1", vmId, 1, "running")], false)
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "running", { limits: { ...NEST_STANDARD_LIMITS, maxVcpus: 2 } }))
    fleet.inventory("host-a", [], true)
    expect(lastCommand("host-a", "setLimits").command).toMatchObject({ limits: NEST_STANDARD_LIMITS })
  })

  test("reconnect does not reconcile stale inventory limits after a live report", async () => {
    const vmId = await runningBox()
    await hello("host-a")
    fleet.inventory("host-a", [vmReport("box-1", vmId, 1, "running", { limits: { ...NEST_STANDARD_LIMITS, maxVcpus: 2 } })], false)
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "running"))
    fleet.inventory("host-a", [], true)
    expect(commandsTo("host-a").filter(({ command }) => command._tag === "setLimits")).toHaveLength(0)
  })
})

describe("owner commands", () => {
  test("a box another user owns is not found", async () => {
    await runningBox()
    expect(await fleet.resume("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
    expect(fleet.suspend("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
    expect(fleet.destroy("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
  })

  test("a command for a box whose host is offline is refused, and nothing is left in flight", async () => {
    await runningBox()
    disconnect("host-a")
    expect(fleet.suspend("alice", "box-1")).toMatchObject({ ok: false, status: 409, tag: "HostOffline" })
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ pending: null })
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

    await fleet.expire(now + 10 * MINUTE - 1)
    expect(fleet.suspend("alice", "box-1")).toMatchObject({ ok: false, status: 409 })

    await fleet.expire(now + 10 * MINUTE)
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

  test("a result from a host other than the one the command went to is ignored", async () => {
    const vmId = await runningBox()
    expect(fleet.suspend("alice", "box-1")).toEqual({ ok: true, value: null })
    const suspend = lastCommand("host-a", "suspend")
    await hello("host-b")

    fleet.result("host-b", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "running", pending: "suspend" })

    fleet.result("host-a", suspend.commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "suspended", pending: null })
  })
})

describe("park and GPU", () => {
  test("parking a running box sends park to its host, and the report it sends back leaves no host", async () => {
    const vmId = await runningBox()
    expect(fleet.park("alice", "box-1")).toEqual({ ok: true, value: null })
    const park = lastCommand("host-a", "park")
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "running", pending: "park" })
    fleet.result("host-a", park.commandId, true, null, vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "parked", pending: null })
  })

  test("a park report that arrives before its result keeps the command in flight until the result", async () => {
    const vmId = await runningBox()
    expect(fleet.park("alice", "box-1")).toEqual({ ok: true, value: null })
    const park = lastCommand("host-a", "park")
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "parked", pending: "park" })
    fleet.result("host-a", park.commandId, true, null, undefined)
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "parked", pending: null })
    await hello("host-b")
    await fleet.wakeRequest("host-a", "box-1")
    const resume = [...commandsTo("host-a"), ...commandsTo("host-b")].find((entry) => entry.command._tag === "resume")
    expect(resume?.command).toMatchObject({ _tag: "resume", ownerEpoch: 2 })
  })

  test("a parked report followed by a lost park result releases the claim at timeout", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    fleet.vm("host-a", vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    disconnect("host-a")
    await fleet.expire(now + 20 * MINUTE)
    await hello("host-b")
    await fleet.resume("alice", "box-1")
    expect(lastCommand("host-b", "resume").command).toMatchObject({ ownerEpoch: 2, volumeRef: "vol-1" })
  })

  test("a resume that succeeds with a running VM keeps the claim for the VM report that follows", async () => {
    const vmId = await runningBox()
    expect(fleet.park("alice", "box-1")).toEqual({ ok: true, value: null })
    const park = lastCommand("host-a", "park")
    fleet.result("host-a", park.commandId, true, null, vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    await fleet.wakeRequest("host-a", "box-1")
    const resume = lastCommand("host-a", "resume")
    fleet.result("host-a", resume.commandId, true, null, vmReport("box-1", resume.command.vmId, 2, "running"))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "running", pending: null })
  })

  test("a placement whose resume cannot be sent is not kept, so the next wake places the box elsewhere", async () => {
    const vmId = await runningBox()
    expect(fleet.park("alice", "box-1")).toEqual({ ok: true, value: null })
    const park = lastCommand("host-a", "park")
    fleet.result("host-a", park.commandId, true, null, vmReport("box-1", vmId, 1, "parked", { volumeRef: "vol-1", backedUpAt: now }))
    closing.add("host-a")
    await fleet.wakeRequest("host-a", "box-1")
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ state: "parked", pending: null })
    disconnect("host-a")
    await hello("host-b")
    expect(lastCommand("host-b", "resume").command).toMatchObject({ ownerEpoch: 2 })
  })

  test("a box another user owns cannot be parked", async () => {
    await runningBox()
    expect(fleet.park("bob", "box-1")).toMatchObject({ ok: false, status: 404 })
  })

  test("a GPU is refused unless the box's limits allow an on-demand GPU", async () => {
    await runningBox()
    expect(fleet.gpu("alice", "box-1", true)).toMatchObject({ ok: false, status: 409, tag: "NoGpuPolicy" })
  })

  test("an on-demand GPU is attached once and detached only while attached", async () => {
    const vmId = await runningBox()
    fleet.setLimits("alice", "box-1", { ...NEST_STANDARD_LIMITS, gpu: "on-demand" })
    fleet.result("host-a", lastCommand("host-a", "setLimits").commandId, true, null, undefined)
    expect(fleet.gpu("alice", "box-1", false)).toMatchObject({ ok: false, status: 409, tag: "NoGpu" })
    expect(fleet.gpu("alice", "box-1", true)).toEqual({ ok: true, value: null })
    const attach = lastCommand("host-a", "gpuAttach")
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ pending: "gpuAttach" })
    fleet.result("host-a", attach.commandId, true, null, vmReport("box-1", vmId, 1, "running", { gpus: ["0000:01:00.0"] }))
    expect(fleet.statusesOf("alice").get("box-1")).toMatchObject({ gpus: 1, pending: null })
    expect(fleet.gpu("alice", "box-1", true)).toMatchObject({ ok: false, status: 409, tag: "GpuAttached" })
    expect(fleet.gpu("alice", "box-1", false)).toEqual({ ok: true, value: null })
    expect(lastCommand("host-a", "gpuDetach").command).toMatchObject({ boxId: "box-1" })
  })
})

describe("reconnect", () => {
  test("a hello sends the lease before it resends in-flight commands, so a resend reaches a host with a valid lease", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    expect(lastCommand("host-a", "create").command._tag).toBe("create")
    disconnect("host-a")

    const before = sent.length
    await hello("host-a")
    const reconnect = sent.slice(before).filter((entry) => entry.hostId === "host-a")
    const leaseAt = reconnect.findIndex((entry) => entry.frame._tag === "lease")
    const resendAt = reconnect.findIndex((entry) => entry.frame._tag === "command")
    expect(resendAt).toBeGreaterThanOrEqual(0)
    expect(leaseAt).toBeGreaterThanOrEqual(0)
    expect(leaseAt).toBeLessThan(resendAt)
  })
})

describe("a park or destroy the host refused for a lapse", () => {
  const commandsSince = (before: number, hostId = "host-a") =>
    sent.slice(before).filter((entry) => entry.hostId === hostId && entry.frame._tag === "command")

  test.each(["park", "destroy"] as const)(
    "a refused %s is sent again on the host's next lease renewal, not before",
    async (action) => {
      const vmId = await runningBox()
      const request = action === "park" ? () => fleet.park("alice", "box-1") : () => fleet.destroy("alice", "box-1")
      expect(request()).toEqual({ ok: true, value: null })
      const first = lastCommand("host-a", action)
      const before = sent.length

      fleet.result("host-a", first.commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
      expect(commandsSince(before)).toHaveLength(0)

      await fleet.capacity("host-a", capacityOf(8))
      const resend = commandsSince(before)
      expect(resend).toHaveLength(1)
      expect(resend[0]?.frame).toMatchObject({ _tag: "command", command: { _tag: action, boxId: "box-1", ownerEpoch: 1 } })
      expect((resend[0]?.frame as { commandId: string }).commandId).not.toBe(first.commandId)
    },
  )

  test("a refused park is sent again at most MAX_LAPSE_RETRIES times in a row, then dropped", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    let id = lastCommand("host-a", "park").commandId
    for (let attempt = 1; attempt <= MAX_LAPSE_RETRIES; attempt++) {
      fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
      const before = sent.length
      await fleet.capacity("host-a", capacityOf(8))
      expect(commandsSince(before)).toHaveLength(1)
      id = lastCommand("host-a", "park").commandId
    }

    fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(commandsSince(before)).toHaveLength(0)

    // The owner's next request starts a fresh run.
    expect(fleet.park("alice", "box-1")).toEqual({ ok: true, value: null })
    expect(commandsSince(before)).toHaveLength(1)
  })

  test("a park refused for another reason is not sent again", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    const first = lastCommand("host-a", "park")
    const before = sent.length

    fleet.result("host-a", first.commandId, false, "backup failed", vmReport("box-1", vmId, 1, "running"))
    await fleet.capacity("host-a", capacityOf(8))

    expect(commandsSince(before)).toHaveLength(0)
  })

  test("a command that runs clears the run's count and any owed resend", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    const first = lastCommand("host-a", "park")
    fleet.result("host-a", first.commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
    await fleet.capacity("host-a", capacityOf(8))
    const second = lastCommand("host-a", "park")
    fleet.result("host-a", second.commandId, true, null, vmReport("box-1", vmId, 1, "parked"))

    const stored = db
      .query<{ retry_kind: string | null; retry_count: number }, []>("SELECT retry_kind, retry_count FROM nest_boxes WHERE box_id = 'box-1'")
      .get()
    expect(stored).toEqual({ retry_kind: null, retry_count: 0 })
  })

  test("an owner's newer request starts its own run: a destroy after an owed park gets the full bound of resends", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    fleet.result("host-a", lastCommand("host-a", "park").commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    let id = lastCommand("host-a", "destroy").commandId
    for (let attempt = 1; attempt <= MAX_LAPSE_RETRIES; attempt++) {
      fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
      const before = sent.length
      await fleet.capacity("host-a", capacityOf(8))
      expect(commandsSince(before)).toHaveLength(1)
      id = lastCommand("host-a", "destroy").commandId
    }
    fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(commandsSince(before)).toHaveLength(0)
  })

  test("an ingress wake does not drop an owed destroy: the destroy goes out on the next renewal after the wake", async () => {
    const vmId = await runningBox()
    expect(fleet.suspend("alice", "box-1")).toEqual({ ok: true, value: null })
    fleet.result("host-a", lastCommand("host-a", "suspend").commandId, true, null, vmReport("box-1", vmId, 1, "suspended"))
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    fleet.result("host-a", lastCommand("host-a", "destroy").commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "suspended"))

    await fleet.wakeRequest("host-a", "box-1")
    const resume = lastCommand("host-a", "resume")
    fleet.result("host-a", resume.commandId, true, null, vmReport("box-1", vmId, 1, "running"))

    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(commandsSince(before).map((entry) => (entry.frame as { command: NestHostCommand }).command._tag)).toEqual(["destroy"])
  })

  test("an owner's limits change does not withdraw an owed destroy: it goes out on the next renewal after the change lands", async () => {
    const vmId = await runningBox()
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    fleet.result("host-a", lastCommand("host-a", "destroy").commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))

    expect(fleet.setLimits("alice", "box-1", NEST_STANDARD_LIMITS)).toEqual({ ok: true, value: null })
    fleet.result("host-a", lastCommand("host-a", "setLimits").commandId, true, null, vmReport("box-1", vmId, 1, "running"))

    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(commandsSince(before).map((entry) => (entry.frame as { command: NestHostCommand }).command._tag)).toEqual(["destroy"])
  })

  test("an owner's newer request replaces an owed resend, which is not sent later", async () => {
    const vmId = await runningBox()
    fleet.park("alice", "box-1")
    const first = lastCommand("host-a", "park")
    fleet.result("host-a", first.commandId, false, NEST_LAPSE_REFUSAL, vmReport("box-1", vmId, 1, "running"))
    expect(fleet.destroy("alice", "box-1")).toEqual({ ok: true, value: null })
    const destroy = lastCommand("host-a", "destroy")
    const before = sent.length

    fleet.result("host-a", destroy.commandId, false, "boom", vmReport("box-1", vmId, 1, "running"))
    await fleet.capacity("host-a", capacityOf(8))

    expect(commandsSince(before)).toHaveLength(0)
  })
})

describe("a create the host refused for a lapse", () => {
  const creates = (before: number) =>
    sent
      .slice(before)
      .filter((entry) => entry.hostId === "host-a" && entry.frame._tag === "command")
      .map((entry) => (entry.frame as { command: NestHostCommand }).command)
      .filter((command) => command._tag === "create")

  test("is sent again on the next lease renewal, and the box is not failed", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    const first = lastCommand("host-a", "create")
    fleet.result("host-a", first.commandId, false, NEST_LAPSE_REFUSAL, undefined)
    expect(fleet.statusesOf("alice").get("box-1")?.failed).toBe(false)

    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    const resend = creates(before)
    expect(resend).toHaveLength(1)
    expect(resend[0]).toMatchObject({ _tag: "create", boxId: "box-1", ownerEpoch: 1 })
    expect(lastCommand("host-a", "create").commandId).not.toBe(first.commandId)
  })

  test("fails the box once the bound is reached", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    let id = lastCommand("host-a", "create").commandId
    for (let attempt = 1; attempt <= MAX_LAPSE_RETRIES; attempt++) {
      fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, undefined)
      await fleet.capacity("host-a", capacityOf(8))
      id = lastCommand("host-a", "create").commandId
    }
    fleet.result("host-a", id, false, NEST_LAPSE_REFUSAL, undefined)
    expect(fleet.statusesOf("alice").get("box-1")?.failed).toBe(true)

    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(creates(before)).toHaveLength(0)
  })

  test("a create refused for another reason fails the box at once, and is not sent again", async () => {
    await hello("host-a")
    await placeBox("alice", "box-1")
    fleet.result("host-a", lastCommand("host-a", "create").commandId, false, "disk full", undefined)
    expect(fleet.statusesOf("alice").get("box-1")?.failed).toBe(true)

    const before = sent.length
    await fleet.capacity("host-a", capacityOf(8))
    expect(creates(before)).toHaveLength(0)
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

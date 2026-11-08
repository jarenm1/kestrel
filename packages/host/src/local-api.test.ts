import { describe, expect, test } from "bun:test"
import type { NestHostCommand, NestVmReport } from "@cloudagents/protocol"
import { handleIngressRequest, handleOperatorRequest } from "./local-api"
import type { VmManager } from "./vm-manager"

const BOX = "box-1"

/** A manager that records the commands it is asked to run; only the members the handlers touch exist. */
const fakeManager = (refuse = false) => {
  const commands: NestHostCommand[] = []
  const manager = {
    reports: (): NestVmReport[] => [],
    epochOf: (boxId: string) => (boxId === BOX ? 3 : null),
    route: (boxId: string) => ({ state: "running", upstream: `http://10.77.0.2:8787#${boxId}` }),
    wake: async (boxId: string) => `http://10.77.0.2:8787#${boxId}`,
    reportActivity: () => undefined,
    executeOperator: async (commandId: string, command: NestHostCommand) => {
      commands.push(command)
      const outcome = refuse
        ? { commandId, boxId: command.boxId, ok: false, error: "refused", reported: false }
        : { commandId, boxId: command.boxId, ok: true, reported: false }
      return { outcome, vm: null }
    },
  }
  return { manager: manager as unknown as VmManager, commands }
}

const post = (path: string, body?: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("ingress surface", () => {
  test.each(["suspend", "park", "destroy"])("%s is not reachable from the ingress socket", async (action) => {
    const { manager, commands } = fakeManager()
    const response = await handleIngressRequest(manager, post(`/v1/boxes/${BOX}/${action}`))
    expect(response.status).toBe(404)
    expect(commands).toEqual([])
  })

  test("listing and inspecting VMs is operator-only", async () => {
    const { manager } = fakeManager()
    expect((await handleIngressRequest(manager, new Request("http://localhost/v1/vms"))).status).toBe(404)
    expect((await handleIngressRequest(manager, new Request(`http://localhost/v1/boxes/${BOX}`))).status).toBe(404)
  })

  test("routing, waking and activity still work", async () => {
    const { manager } = fakeManager()
    const route = await handleIngressRequest(manager, new Request(`http://localhost/v1/boxes/${BOX}/route`))
    expect(route.status).toBe(200)
    const wake = await handleIngressRequest(manager, post(`/v1/boxes/${BOX}/wake`))
    expect(await wake.json()).toEqual({ upstream: `http://10.77.0.2:8787#${BOX}` })
    const activity = await handleIngressRequest(
      manager,
      post("/v1/ingress/activity", { boxes: [{ boxId: BOX, openConnections: 1, lastRequestAt: null }] }),
    )
    expect(activity.status).toBe(204)
  })
})

describe("operator surface", () => {
  test.each(["suspend", "park", "destroy"] as const)("%s runs the command for the box", async (action) => {
    const { manager, commands } = fakeManager()
    const response = await handleOperatorRequest(manager, post(`/v1/boxes/${BOX}/${action}`))
    expect(response.status).toBe(200)
    expect(commands).toEqual([{ _tag: action, boxId: BOX, ownerEpoch: 3 }])
  })

  test("an operator command for a box this host does not hold answers 404 without running", async () => {
    const { manager, commands } = fakeManager()
    const response = await handleOperatorRequest(manager, post("/v1/boxes/box-2/park"))
    expect(response.status).toBe(404)
    expect(commands).toEqual([])
  })

  test("a refused command answers 409 with the error", async () => {
    const { manager } = fakeManager(true)
    const response = await handleOperatorRequest(manager, post(`/v1/boxes/${BOX}/destroy`))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: "refused" })
  })

  test("ingress-only routes are not served here", async () => {
    const { manager } = fakeManager()
    const response = await handleOperatorRequest(manager, new Request(`http://localhost/v1/boxes/${BOX}/route`))
    expect(response.status).toBe(404)
  })
})

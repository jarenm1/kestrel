import { describe, expect, test } from "bun:test"
import type { Run, ServerEvent } from "@cloudagents/protocol"
import { GpuWishes, withdrawWishesOnRunEnd } from "./gpu-wish"

describe("GpuWishes", () => {
  test("the GPU stays wanted while another run still wants it", () => {
    const wishes = new GpuWishes()
    expect(wishes.add("run-a")).toBe(true)
    expect(wishes.add("run-b")).toBe(true)
    expect(wishes.remove("run-a")).toBe(true)
    expect(wishes.wanted()).toBe(true)
    expect(wishes.remove("run-b")).toBe(false)
  })

  test("withdrawing a run that never asked leaves the others' wish standing", () => {
    const wishes = new GpuWishes()
    wishes.add("run-a")
    expect(wishes.remove("run-b")).toBe(true)
    expect(wishes.wanted()).toBe(true)
  })

  test("a repeated request from one run is one wish, withdrawn by one release", () => {
    const wishes = new GpuWishes()
    wishes.add("run-a")
    expect(wishes.add("run-a")).toBe(true)
    expect(wishes.remove("run-a")).toBe(false)
  })
})

/** An event hub stand-in: `publish` delivers an event to every subscriber, as the server's EventHub does. */
const fakeHub = () => {
  const listeners = new Set<(event: ServerEvent) => void>()
  return {
    subscribeAll: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (event: ServerEvent) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

const runUpdated = (runId: string, status: Run["status"]): ServerEvent => ({
  _tag: "run.updated",
  run: { id: runId, taskId: "task-1", prompt: "", status, startedAt: "", endedAt: null, exitCode: null },
})

/**
 * The platform's wiring: each wish change is what the guest link is told (`guestWanted`), and a run's end withdraws its
 * wish through the event hub.
 */
const wiredWishes = () => {
  const wishes = new GpuWishes()
  const hub = fakeHub()
  const guestWanted: boolean[] = []
  withdrawWishesOnRunEnd(hub.subscribeAll, wishes, (wanted) => guestWanted.push(wanted))
  return { wishes, hub, guestWanted }
}

describe("withdrawWishesOnRunEnd", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    test(`a run that ends ${status} without releasing the GPU clears its wish and the box stops wanting it`, () => {
      const { wishes, hub, guestWanted } = wiredWishes()
      guestWanted.push(wishes.add("run-a"))
      hub.publish(runUpdated("run-a", "running"))
      expect(wishes.wanted()).toBe(true)
      hub.publish(runUpdated("run-a", status))
      expect(wishes.wanted()).toBe(false)
      expect(guestWanted).toEqual([true, false])
    })
  }

  test("a run that ends while another run still wants the GPU leaves it wanted", () => {
    const { wishes, hub, guestWanted } = wiredWishes()
    guestWanted.push(wishes.add("run-a"))
    guestWanted.push(wishes.add("run-b"))
    hub.publish(runUpdated("run-a", "succeeded"))
    expect(wishes.wanted()).toBe(true)
    hub.publish(runUpdated("run-b", "failed"))
    expect(wishes.wanted()).toBe(false)
    expect(guestWanted).toEqual([true, true, true, false])
  })

  test("a run that ends without ever asking for the GPU changes nothing", () => {
    const { wishes, hub, guestWanted } = wiredWishes()
    guestWanted.push(wishes.add("run-a"))
    hub.publish(runUpdated("run-b", "succeeded"))
    expect(wishes.wanted()).toBe(true)
    expect(guestWanted).toEqual([true])
  })
})

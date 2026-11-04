import { describe, expect, test } from "bun:test"
import { GpuWishes } from "./gpu-wish"

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

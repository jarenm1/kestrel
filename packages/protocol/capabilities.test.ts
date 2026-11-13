import { expect, test } from "bun:test"
import { Schema } from "effect"
import { BoxCapabilities } from "./src/index"

const decode = Schema.decodeUnknownSync(BoxCapabilities)

test("a v1 box from before the additive fields still decodes", () => {
  const old = { version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable" } as const
  expect(decode(old)).toEqual(old)
})

test("decodes every capability fact the box reports", () => {
  const full = {
    version: 1,
    platform: "lima",
    sandbox: "strict",
    desktop: "prerequisites-present",
    harnesses: ["anthropic", "openai"],
    modelHarnesses: ["claude", "codex"],
    gpu: "on-demand",
    suspend: true,
    encoder: "unknown",
    gpuRendering: "hardware",
    toolkits: ["blender", "roblox-studio"],
    capacity: { maxConcurrentRuns: 3 },
    automations: true,
  } as const
  expect(decode(full)).toEqual(full)
})

test("an empty toolkit list and unlimited capacity are facts, not absences", () => {
  expect(decode({
    version: 1,
    platform: "linux",
    sandbox: "off",
    desktop: "unavailable",
    encoder: "none",
    gpuRendering: "none",
    toolkits: [],
    capacity: { maxConcurrentRuns: 0 },
    automations: false,
  })).toMatchObject({
    toolkits: [],
    capacity: { maxConcurrentRuns: 0 },
    automations: false,
  })
})

test("additive fields within version 1 are ignored", () => {
  const capability = { version: 1, platform: "other", sandbox: "off", desktop: "unavailable", future: true } as const
  expect(decode(capability)).toEqual({ version: 1, platform: "other", sandbox: "off", desktop: "unavailable" })
})

test("closed value sets and capacity types are validated", () => {
  const base = { version: 1, platform: "linux", sandbox: "basic", desktop: "unavailable" } as const
  expect(() => decode({ ...base, version: 2 })).toThrow()
  expect(() => decode({ ...base, encoder: "vaapi" })).toThrow()
  expect(() => decode({ ...base, gpuRendering: "virtual" })).toThrow()
  expect(() => decode({ ...base, capacity: { maxConcurrentRuns: -1 } })).toThrow()
  expect(() => decode({ ...base, capacity: { maxConcurrentRuns: 1.5 } })).toThrow()
  expect(() => decode({ ...base, capacity: {} })).toThrow()
  expect(() => decode({ ...base, automations: "yes" })).toThrow()
  expect(() => decode({ ...base, toolkits: [1] })).toThrow()
})

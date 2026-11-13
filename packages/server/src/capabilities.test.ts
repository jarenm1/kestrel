import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { BOX_USER_HEADER, BoxCapabilities, Health, Paths } from "@cloudagents/protocol"
import { boxCapabilities } from "./capabilities"
import { DESKTOP_HELPER, DESKTOP_OPTIONAL_TOOLS, DESKTOP_REQUIRED_TOOLS } from "./desktop/requirements"
import { makeWebHandler } from "./http/router"

const linux = {
  platform: "linux" as const,
  release: "6.12.0",
  exists: () => false,
  executable: () => true,
  westonVersion: () => "weston 14.0.1\n",
  renderNode: () => false,
}

/** The facts a box with no flake, no control plane and unlimited runs reports alongside its host probe. */
const BASE = {
  toolkits: [],
  capacity: { maxConcurrentRuns: 0 },
  automations: false,
} as const

test("reports the configured sandbox, without inferring it from installed tools", () => {
  for (const sandbox of ["strict", "basic", "off"] as const) {
    const capability = boxCapabilities(sandbox, linux)
    expect(Schema.decodeUnknownSync(BoxCapabilities)(capability)).toEqual({
      version: 1, platform: "linux", sandbox, desktop: "prerequisites-present", gpu: "none", suspend: false,
      encoder: "x264", gpuRendering: "software", ...BASE,
    })
  }
})

test("recognizes WSL and does not promise a desktop on native Windows or macOS", () => {
  expect(boxCapabilities("basic", { ...linux, release: "6.6.87.2-microsoft-standard-WSL2" }).platform).toBe("wsl")
  for (const platform of ["win32", "darwin"] as const) {
    expect(boxCapabilities("off", {
      ...linux, platform,
      executable: () => { throw new Error("must not probe Linux tools") },
    })).toEqual({
      version: 1, platform: "other", sandbox: "off", desktop: "unavailable", gpu: "none", suspend: false,
      encoder: "none", gpuRendering: "none", ...BASE,
    })
  }
})

test("recognizes a Lima guest by its cloud-init seed, whatever the kernel release", () => {
  const lima = { ...linux, exists: (path: string) => path === "/mnt/lima-cidata" }
  expect(boxCapabilities("basic", lima)).toEqual({
    version: 1, platform: "lima", sandbox: "basic", desktop: "prerequisites-present", gpu: "none", suspend: false,
    encoder: "x264", gpuRendering: "software", ...BASE,
  })
  expect(boxCapabilities("basic", { ...lima, exists: () => false }).platform).toBe("linux")
  expect(boxCapabilities("basic", { ...lima, platform: "darwin" }).platform).toBe("other")
})

test("a Nest VM reports the GPU and suspend its platform gives; a plain box reports its own render node", () => {
  const nest = boxCapabilities("basic", linux, { gpu: "on-demand", suspend: true })
  expect(Schema.decodeUnknownSync(BoxCapabilities)(nest)).toMatchObject({
    gpu: "on-demand", suspend: true, encoder: "unknown", gpuRendering: "hardware",
  })
  expect(boxCapabilities("basic", { ...linux, renderNode: () => true })).toMatchObject({
    gpu: "static", encoder: "x264", gpuRendering: "hardware",
  })
  expect(boxCapabilities("basic", linux)).toMatchObject({
    gpu: "none", suspend: false, encoder: "x264", gpuRendering: "software",
  })
})

test("the encoder is unknown only where an NVIDIA device could carry NVENC", () => {
  const nvidia = { ...linux, exists: (path: string) => path === "/dev/nvidia0" }
  expect(boxCapabilities("basic", nvidia).encoder).toBe("unknown")
  expect(boxCapabilities("basic", { ...linux, exists: (path: string) => path === "/dev/nvidiactl" }).encoder).toBe("unknown")
  // WSL always encodes on the CPU, even when an NVIDIA device is visible.
  expect(boxCapabilities("basic", {
    ...nvidia, release: "6.6.87.2-microsoft-standard-WSL2",
  }).encoder).toBe("x264")
})

test("reports the toolkit names, run capacity and control-plane support it was given", () => {
  const capability = boxCapabilities("strict", linux, null, {
    toolkitNames: ["blender", "roblox-studio"],
    maxConcurrentRuns: 3,
    automations: true,
  })
  expect(Schema.decodeUnknownSync(BoxCapabilities)(capability)).toMatchObject({
    toolkits: ["blender", "roblox-studio"],
    capacity: { maxConcurrentRuns: 3 },
    automations: true,
  })
  expect(boxCapabilities("basic", linux).toolkits).toEqual([])
})

test("a missing required desktop tool prevents reporting desktop prerequisites; optional tools do not", () => {
  for (const missing of [...DESKTOP_REQUIRED_TOOLS, DESKTOP_HELPER]) {
    expect(boxCapabilities("basic", { ...linux, executable: (name) => name !== missing })).toMatchObject({
      desktop: "unavailable", encoder: "none", gpuRendering: "none",
    })
  }
  for (const missing of DESKTOP_OPTIONAL_TOOLS) {
    expect(boxCapabilities("basic", { ...linux, executable: (name) => name !== missing }).desktop).toBe("prerequisites-present")
  }
})

test("old or unknown Weston versions are unavailable", () => {
  for (const version of ["weston 13.0.3", "unknown", "weston 1.4.0", ""]) {
    expect(boxCapabilities("basic", { ...linux, westonVersion: () => version }).desktop).toBe("unavailable")
  }
})

test("capability discovery needs a signed-in user and preserves health and unknown-route behavior", async () => {
  const capabilities = boxCapabilities("off", linux)
  const models = {
    get: () => Effect.succeed({ models: [], sources: [] }),
    list: () => Effect.succeed({ models: [], sources: [] }),
  }
  const handler = await Effect.runPromise(makeWebHandler({} as never, {} as never, capabilities, models))
  expect((await handler(new Request(`http://box.test${Paths.capabilities}`))).status).toBe(401)
  expect((await handler(new Request(`http://box.test${Paths.models}`))).status).toBe(401)
  const signedIn = await handler(new Request(`http://box.test${Paths.capabilities}`, { headers: { [BOX_USER_HEADER]: "alice" } }))
  expect(signedIn.status).toBe(200)
  expect(Schema.decodeUnknownSync(BoxCapabilities)(await signedIn.json())).toEqual(capabilities)
  const health = await handler(new Request(`http://box.test${Paths.health}`))
  expect(health.status).toBe(200)
  expect(Schema.decodeUnknownSync(Health)(await health.json()).ok).toBe(true)
  expect((await handler(new Request("http://box.test/api/no-such-route"))).status).toBe(404)
})

test("v1 decoding tolerates additive fields and rejects unsupported contract versions", () => {
  const capabilities = boxCapabilities("basic", linux)
  expect(Schema.decodeUnknownSync(BoxCapabilities)({ ...capabilities, future: true })).toEqual(capabilities)
  expect(() => Schema.decodeUnknownSync(BoxCapabilities)({ ...capabilities, version: 2 })).toThrow()
})

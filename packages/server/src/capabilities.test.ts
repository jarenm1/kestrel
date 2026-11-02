import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { BoxCapabilities, Health, Paths } from "@cloudagents/protocol"
import { boxCapabilities } from "./capabilities"
import { makeWebHandler } from "./http/router"

const linux = {
  platform: "linux" as const,
  release: "6.12.0",
  exists: () => false,
  executable: () => true,
  westonVersion: () => "weston 14.0.1\n",
}

test("reports the configured sandbox, without inferring it from installed tools", () => {
  for (const sandbox of ["strict", "basic", "off"] as const) {
    const capability = boxCapabilities(sandbox, linux)
    expect(Schema.decodeUnknownSync(BoxCapabilities)(capability)).toEqual({
      version: 1, platform: "linux", sandbox, desktop: "prerequisites-present",
    })
  }
})

test("recognizes WSL and does not promise a desktop on native Windows or macOS", () => {
  expect(boxCapabilities("basic", { ...linux, release: "6.6.87.2-microsoft-standard-WSL2" }).platform).toBe("wsl")
  for (const platform of ["win32", "darwin"] as const) {
    expect(boxCapabilities("off", {
      ...linux, platform,
      executable: () => { throw new Error("must not probe Linux tools") },
    })).toEqual({ version: 1, platform: "other", sandbox: "off", desktop: "unavailable" })
  }
})

test("recognizes a Lima guest by its cloud-init seed, whatever the kernel release", () => {
  const lima = { ...linux, exists: (path: string) => path === "/mnt/lima-cidata" }
  expect(boxCapabilities("basic", lima)).toEqual({
    version: 1, platform: "lima", sandbox: "basic", desktop: "prerequisites-present",
  })
  expect(boxCapabilities("basic", { ...lima, exists: () => false }).platform).toBe("linux")
  expect(boxCapabilities("basic", { ...lima, platform: "darwin" }).platform).toBe("other")
})

test("missing capture or input tools prevent reporting desktop prerequisites", () => {
  for (const missing of ["weston", "Xwayland", "openbox", "xdotool", "ffmpeg", "xdamage-capture"]) {
    expect(boxCapabilities("basic", { ...linux, executable: (name) => name !== missing }).desktop).toBe("unavailable")
  }
})

test("old, unknown or failing Weston versions are unavailable", () => {
  for (const version of ["weston 13.0.3", "unknown", "weston 1.4.0"]) {
    expect(boxCapabilities("basic", { ...linux, westonVersion: () => version }).desktop).toBe("unavailable")
  }
  expect(boxCapabilities("basic", {
    ...linux, westonVersion: () => { throw new Error("timed out") },
  }).desktop).toBe("unavailable")
})

test("capability discovery preserves health and unknown-route behavior", async () => {
  const capabilities = boxCapabilities("off", linux)
  const handler = await Effect.runPromise(makeWebHandler({} as never, {} as never, capabilities))
  const response = await handler(new Request(`http://box.test${Paths.capabilities}`))
  expect(response.status).toBe(200)
  expect(Schema.decodeUnknownSync(BoxCapabilities)(await response.json())).toEqual(capabilities)
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

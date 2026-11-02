import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { loadConfig } from "./config"

const BOX_VARS = [
  "CLOUDAGENTS_CONTROL_URL",
  "CLOUDAGENTS_BOX_ID",
  "CLOUDAGENTS_BOX_SECRET",
  "CLOUDAGENTS_BOX_MANAGED",
  "CLOUDAGENTS_BOX_TOKEN",
  "CLOUDAGENTS_PORT",
  "CLOUDAGENTS_HOST",
  "CLOUDAGENTS_SANDBOX_PORT",
] as const

const CONTROL = "https://control.example"
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of BOX_VARS) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

const configWith = (env: Record<string, string>) => {
  for (const name of BOX_VARS) delete process.env[name]
  Object.assign(process.env, env)
  return loadConfig()
}

describe("sandbox listener settings", () => {
  test("wildcard public binding never changes the loopback sandbox URL", () => {
    const config = configWith({ CLOUDAGENTS_HOST: "::", CLOUDAGENTS_PORT: "9000" })
    expect(config.sandboxPort).toBe(19000)
    expect(config.mcpBaseUrl).toBe("http://127.0.0.1:19000")
  })

  test("a separate port can be configured and invalid or shared ports are refused", () => {
    expect(configWith({ CLOUDAGENTS_PORT: "9000", CLOUDAGENTS_SANDBOX_PORT: "20000" }).sandboxPort).toBe(20000)
    for (const port of ["0", "65536", "1.5", "bad", "9000"]) {
      expect(() => configWith({ CLOUDAGENTS_PORT: "9000", CLOUDAGENTS_SANDBOX_PORT: port })).toThrow()
    }
  })
})

describe("managed box settings", () => {
  test("CLOUDAGENTS_BOX_MANAGED=1 needs the box id, its secret and the control plane URL", () => {
    const message = "CLOUDAGENTS_BOX_MANAGED=1 requires CLOUDAGENTS_BOX_ID, CLOUDAGENTS_BOX_SECRET and CLOUDAGENTS_CONTROL_URL"
    expect(() => configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_BOX_ID: "box", CLOUDAGENTS_BOX_SECRET: "s" })).toThrow(
      message,
    )
    expect(() =>
      configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_SECRET: "s" }),
    ).toThrow(message)
    expect(() => configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_ID: "box" })).toThrow(
      message,
    )
  })

  test("a managed box is direct and marked managed", () => {
    const config = configWith({
      CLOUDAGENTS_CONTROL_URL: CONTROL,
      CLOUDAGENTS_BOX_ID: "box_fleet_1",
      CLOUDAGENTS_BOX_SECRET: "secret",
      CLOUDAGENTS_BOX_MANAGED: "1",
    })
    expect(config.direct).toEqual({ controlUrl: CONTROL, boxId: "box_fleet_1", boxSecret: "secret", managed: true })
    expect(config.relay).toBeNull()
  })

  test("the relay token and managed direct mode coexist", () => {
    const config = configWith({
      CLOUDAGENTS_CONTROL_URL: CONTROL,
      CLOUDAGENTS_BOX_ID: "box_fleet_1",
      CLOUDAGENTS_BOX_SECRET: "secret",
      CLOUDAGENTS_BOX_MANAGED: "1",
      CLOUDAGENTS_BOX_TOKEN: "relay-token",
    })
    expect(config.direct?.managed).toBe(true)
    expect(config.relay).toEqual({ controlUrl: CONTROL, boxToken: "relay-token" })
  })

  test("a user's own box stays unmanaged", () => {
    const config = configWith({ CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_ID: "box_own", CLOUDAGENTS_BOX_SECRET: "secret" })
    expect(config.direct).toEqual({ controlUrl: CONTROL, boxId: "box_own", boxSecret: "secret", managed: false })
  })

  test("without box id or secret there is no direct mode, and the relay needs only its token", () => {
    const config = configWith({ CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_TOKEN: "relay-token" })
    expect(config.direct).toBeNull()
    expect(config.relay).toEqual({ controlUrl: CONTROL, boxToken: "relay-token" })
  })

  test("a box id without the control plane URL is refused", () => {
    expect(() => configWith({ CLOUDAGENTS_BOX_ID: "box_own", CLOUDAGENTS_BOX_SECRET: "secret" })).toThrow(
      "CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_ID is set",
    )
  })
})

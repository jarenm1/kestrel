import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { loadConfig } from "./config"

const KEYS = [
  "CLOUDAGENTS_BOX_ID",
  "CLOUDAGENTS_BOX_SECRET",
  "CLOUDAGENTS_BOX_TOKEN",
  "CLOUDAGENTS_BOX_PUBLIC_KEY",
  "CLOUDAGENTS_CONTROL_URL",
] as const

const publicJwk = { kty: "EC", crv: "P-256", x: "AAAA", y: "BBBB" }

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("managed box configuration", () => {
  test("refuses a public key that carries private key material, without echoing it", () => {
    process.env.CLOUDAGENTS_CONTROL_URL = "https://control.example"
    process.env.CLOUDAGENTS_BOX_TOKEN = "service-token"
    process.env.CLOUDAGENTS_BOX_PUBLIC_KEY = JSON.stringify({ ...publicJwk, d: "SECRET-PRIVATE-SCALAR" })

    let failure: unknown
    try {
      loadConfig()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("SECRET-PRIVATE-SCALAR")
  })

  test("refuses a managed token without a control URL instead of falling back", () => {
    process.env.CLOUDAGENTS_BOX_TOKEN = "service-token"
    process.env.CLOUDAGENTS_BOX_PUBLIC_KEY = JSON.stringify(publicJwk)

    expect(() => loadConfig()).toThrow()
  })

  test("refuses the managed service token unless managed mode is configured", () => {
    process.env.CLOUDAGENTS_CONTROL_URL = "https://control.example"
    process.env.CLOUDAGENTS_BOX_TOKEN = "service-token"
    expect(() => loadConfig()).toThrow()

    process.env.CLOUDAGENTS_BOX_ID = "box-1"
    process.env.CLOUDAGENTS_BOX_SECRET = "box-secret"
    expect(() => loadConfig()).toThrow()
  })
})

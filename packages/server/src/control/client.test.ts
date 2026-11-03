import { describe, expect, test } from "bun:test"
import type { ServerConfig } from "../config"
import { boxControl } from "./client"

const config = (fields: Pick<ServerConfig, "relay" | "direct">) => fields as ServerConfig
const direct = { controlUrl: "https://control.example.com", boxId: "b", boxSecret: "s" }

describe("boxControl", () => {
  test("a user's own box has no control client, so it has no automations and reports no tool failures", () => {
    expect(boxControl(config({ relay: null, direct: { ...direct, managed: false } as ServerConfig["direct"] }))).toBeNull()
    expect(boxControl(config({ relay: null, direct: null }))).toBeNull()
  })

  test("Kestrel's own boxes have one", () => {
    expect(boxControl(config({ relay: null, direct: { ...direct, managed: true } as ServerConfig["direct"] }))).not.toBeNull()
    expect(boxControl(config({ relay: { controlUrl: "https://control.example.com", boxToken: "t" }, direct: null }))).not.toBeNull()
  })
})

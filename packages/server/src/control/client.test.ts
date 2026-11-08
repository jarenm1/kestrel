import { describe, expect, test } from "bun:test"
import type { ServerConfig } from "../config"
import { boxControl } from "./client"

const config = (fields: Pick<ServerConfig, "direct">) => fields as ServerConfig
const direct = { controlUrl: "https://control.example.com", boxId: "b", boxSecret: "s" }

describe("boxControl", () => {
  test("a user's own box has no control client, so it has no automations and reports no tool failures", () => {
    expect(boxControl(config({ direct: null }))).toBeNull()
    expect(boxControl(config({ direct: null }))).toBeNull()
  })

  test("Kestrel's own boxes have one", () => {
    expect(boxControl(config({ direct }))).not.toBeNull()
      })
})

import { describe, expect, test } from "bun:test"
import { requireTool } from "./tools"

describe("requireTool", () => {
  test("accepts an absolute path to an executable", () => {
    expect(() => requireTool(process.execPath)).not.toThrow()
  })

  test("rejects an absolute path that does not exist", () => {
    expect(() => requireTool("/nonexistent/kestrel-volume")).toThrow("required tool not found: /nonexistent/kestrel-volume")
  })

  test("finds a bare name on PATH", () => {
    expect(() => requireTool("sh")).not.toThrow()
  })
})

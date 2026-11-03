import { describe, expect, test } from "bun:test"
import { isWslKernel } from "./platform"

describe("WSL kernel detection", () => {
  test("recognizes WSL 1 and WSL 2 releases without relying on the environment", () => {
    expect(isWslKernel("4.4.0-19041-Microsoft")).toBe(true)
    expect(isWslKernel("5.15.153.1-microsoft-standard-WSL2")).toBe(true)
    expect(isWslKernel("6.8.0-48-generic")).toBe(false)
  })
})

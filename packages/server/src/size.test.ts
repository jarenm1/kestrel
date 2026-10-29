import { describe, expect, test } from "bun:test"
import { parseCpuQuota, parseSize } from "./size"

describe("parseSize", () => {
  test("suffixes are base 1024, as systemd reads them", () => {
    expect(parseSize("4G")).toBe(4 * 1024 ** 3)
    expect(parseSize("50g")).toBe(50 * 1024 ** 3)
    expect(parseSize("512M")).toBe(512 * 1024 ** 2)
    expect(parseSize("1.5T")).toBe(1.5 * 1024 ** 4)
    expect(parseSize("4096")).toBe(4096)
  })

  test("values systemd accepts that are not a byte count are null", () => {
    expect(parseSize("infinity")).toBeNull()
    expect(parseSize("50%")).toBeNull()
    expect(parseSize("4GB")).toBeNull()
    expect(parseSize("")).toBeNull()
  })
})

describe("parseCpuQuota", () => {
  test("percent is cores", () => {
    expect(parseCpuQuota("200%")).toBe(2)
    expect(parseCpuQuota("50%")).toBe(0.5)
  })

  test("anything else is null", () => {
    expect(parseCpuQuota("2")).toBeNull()
    expect(parseCpuQuota("")).toBeNull()
  })
})

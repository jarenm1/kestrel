import { describe, expect, test } from "bun:test"
import { formatElapsed } from "./util"

const at = (seconds: number) => formatElapsed(0, seconds * 1000)

describe("formatElapsed", () => {
  test("seconds alone until a minute has passed", () => {
    expect(at(0)).toBe("0s")
    expect(at(59)).toBe("59s")
    expect(formatElapsed(0, 59_999)).toBe("59s")
  })

  test("minutes appear once one has passed, and keep a 0s", () => {
    expect(at(60)).toBe("1m 0s")
    expect(at(3599)).toBe("59m 59s")
  })

  test("hours appear once one has passed, and keep 0m and 0s", () => {
    expect(at(3600)).toBe("1h 0m 0s")
    expect(at(3600 + 5)).toBe("1h 0m 5s")
    expect(at(26 * 3600 + 61)).toBe("26h 1m 1s")
  })

  test("a start in the future (clock skew with the box) reads 0s, not negative", () => {
    expect(formatElapsed(10_000, 0)).toBe("0s")
  })
})

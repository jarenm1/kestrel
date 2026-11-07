import { expect, test } from "bun:test"
import { profileFor, profileRestartNeeded } from "./profile"

const high = { baselineOnly: false }
const baseline = { baselineOnly: true }

test("a Baseline-only viewer pulls the whole stream to Constrained Baseline", () => {
  expect(profileFor([high])).toBe("high")
  expect(profileFor([high, baseline])).toBe("baseline")
  expect(profileFor([])).toBe("high")
})

test("a High encoder restarts when a Baseline-only viewer attaches", () => {
  expect(profileRestartNeeded([high, baseline], "high")).toBe(true)
})

test("a Baseline encoder restarts when its last Baseline-only viewer leaves", () => {
  expect(profileRestartNeeded([high], "baseline")).toBe(true)
})

test("no restart when the live profile already matches, or when nothing is running", () => {
  expect(profileRestartNeeded([high], "high")).toBe(false)
  expect(profileRestartNeeded([baseline], "baseline")).toBe(false)
  expect(profileRestartNeeded([baseline], null)).toBe(false)
  // The last viewer leaving stops the encoder through its linger timer, not through a profile restart.
  expect(profileRestartNeeded([], "high")).toBe(false)
})

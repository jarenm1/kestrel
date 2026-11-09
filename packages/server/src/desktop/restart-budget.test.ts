import { describe, expect, test } from "bun:test"
import {
  ENCODER_STABLE_MS,
  MAX_ENCODER_RESTARTS,
  encoderConfigured,
  encoderRestart,
  encoderStable,
  restartBudget,
  viewerServed,
} from "./restart-budget"

describe("encoder restart budget", () => {
  test("a config alone does not restore the budget: a crash loop still reaches the limit", () => {
    let budget = restartBudget()
    for (let i = 0; i < MAX_ENCODER_RESTARTS; i++) {
      // Initialize, then die before the stability window.
      budget = encoderConfigured(budget, i * 1_000)
      const restarted = encoderRestart(budget)
      expect(restarted.allowed).toBe(true)
      budget = restarted.budget
    }
    // The next config does not buy another restart.
    budget = encoderConfigured(budget, MAX_ENCODER_RESTARTS * 1_000)
    expect(encoderRestart(budget).allowed).toBe(false)
  })

  test("a stable live period resets the budget", () => {
    let budget = restartBudget()
    budget = encoderConfigured(budget, 1_000)
    budget = encoderRestart(budget).budget
    expect(budget.left).toBe(MAX_ENCODER_RESTARTS - 1)

    // The restarted encoder configures again; its stability window starts then.
    budget = encoderConfigured(budget, 2_000)
    budget = encoderStable(budget, 2_000 + ENCODER_STABLE_MS - 1)
    expect(budget.left).toBe(MAX_ENCODER_RESTARTS - 1)
    budget = encoderStable(budget, 2_000 + ENCODER_STABLE_MS)
    expect(budget.left).toBe(MAX_ENCODER_RESTARTS)
  })

  test("a served viewer resets the budget", () => {
    let budget = restartBudget()
    budget = encoderRestart(encoderConfigured(budget, 0)).budget
    budget = encoderRestart(encoderConfigured(budget, 10)).budget
    expect(budget.left).toBe(MAX_ENCODER_RESTARTS - 2)
    expect(viewerServed().left).toBe(MAX_ENCODER_RESTARTS)
  })
})

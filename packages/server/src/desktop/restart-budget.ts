/** Unexpected encoder restarts tolerated before the desktop fails. */
export const MAX_ENCODER_RESTARTS = 3

/**
 * How long an encoder must stay live after its first config before it earns the restart budget back. A process that
 * initializes and dies in a loop must not reset its own budget on every config.
 */
export const ENCODER_STABLE_MS = 30_000

/** One desktop encoder's unexpected-restart budget. */
export interface RestartBudget {
  /** Unexpected exits still tolerated; the desktop fails when an exit finds none left. */
  readonly left: number
  /** When the live encoder produced its first config, or null while none is live. */
  readonly liveSince: number | null
}

export const restartBudget = (): RestartBudget => ({ left: MAX_ENCODER_RESTARTS, liveSince: null })

/** A config says the encoder initialized, not that it stays alive: it starts the stability window but grants nothing. */
export const encoderConfigured = (budget: RestartBudget, at: number): RestartBudget => ({ ...budget, liveSince: at })

/** A live period of at least `ENCODER_STABLE_MS` earns the whole budget back. */
export const encoderStable = (budget: RestartBudget, at: number): RestartBudget =>
  budget.liveSince !== null && at - budget.liveSince >= ENCODER_STABLE_MS
    ? { left: MAX_ENCODER_RESTARTS, liveSince: null }
    : budget

/** A viewer that reached the live stream proves the encoder works, so its session resets the budget. */
export const viewerServed = (): RestartBudget => ({ left: MAX_ENCODER_RESTARTS, liveSince: null })

/** An unexpected exit after config spends one restart; `allowed` is false when the desktop must fail instead. */
export const encoderRestart = (budget: RestartBudget): { readonly budget: RestartBudget; readonly allowed: boolean } =>
  budget.left > 0
    ? { budget: { left: budget.left - 1, liveSince: null }, allowed: true }
    : { budget: { left: 0, liveSince: null }, allowed: false }

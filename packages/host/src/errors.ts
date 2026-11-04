/** An operational failure: shown to the operator as a message, exit code 1. */
export class HostError extends Error {
  readonly exitCode: number = 1
}

/** Bad command line: usage is printed, exit code 2. */
export class UsageError extends Error {
  readonly exitCode: number = 2
}

/** The box is not on this host (never placed here, or deleted): the local API answers 404. */
export class UnknownBoxError extends HostError {}

/** A box did not reach `running` in time: the local API answers 503. */
export class WakeTimeoutError extends HostError {}

/** The message of any thrown value, without casting it. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

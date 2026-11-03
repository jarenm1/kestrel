/** An operational failure: shown to the operator as a message, exit code 1. */
export class HostError extends Error {
  readonly exitCode: number = 1
}

/** Bad command line: usage is printed, exit code 2. */
export class UsageError extends Error {
  readonly exitCode: number = 2
}

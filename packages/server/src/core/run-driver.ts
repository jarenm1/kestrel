/*
 * A run whose CLI the harness talks to over stdin while it works: Codex app-server (`codex-app-server.ts`) and
 * Claude Code's stream-json input (`claude-stream.ts`). Every stdout line still goes through the run's transcript;
 * a driver only follows the turn and answers what the CLI asks.
 */

/**
 * How a run's turn ended; null while it has not. A failure's `error` is set when nothing in the stream reported it
 * (a refused request, an early exit); a failed turn reports its own error in the stream, for the transcript.
 */
export type RunOutcome =
  | { readonly status: "completed" }
  | { readonly status: "interrupted" }
  | { readonly status: "failed"; readonly error: string | null }

export interface RunDriver {
  /** Opens the conversation and sends the prompt. */
  readonly start: () => void
  /** Every message the CLI prints, in order. */
  readonly receive: (message: unknown) => void
  /** Adds `text` to the running turn. Resolves false when the turn can no longer take it. */
  readonly steer: (text: string) => Promise<boolean>
  /** Asks the CLI to stop the running turn; false when it cannot be asked (the process is signalled instead). */
  readonly interrupt: () => boolean
  /** The CLI has exited: what it never answered fails, and a turn that never finished failed. */
  readonly close: () => void
  readonly outcome: () => RunOutcome | null
}

import { modelInfo, type AgentModel, type ModelProvider, type Run } from "@cloudagents/protocol"

/**
 * The provider whose commands the thread's next message can run. A running run owns that message, so its own
 * provider wins even before the harness records a session; then the run's session; then the composer's model.
 */
export const commandProvider = (
  running: Run | undefined,
  session: { readonly provider: ModelProvider } | undefined,
  model: AgentModel,
): ModelProvider =>
  running?.provider ?? (running === undefined ? undefined : session?.provider) ?? modelInfo(model).provider

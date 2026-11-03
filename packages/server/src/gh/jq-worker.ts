// Evaluates one jq program on a worker thread, so a runaway filter can be stopped without blocking the box.
import { loadJq } from "jq-wasm/inline"

declare const self: Worker

export interface JqRequest {
  readonly input: unknown
  readonly filter: string
}

export type JqReply = { readonly outputs: ReadonlyArray<unknown> } | { readonly error: string }

const jq = await loadJq()

self.onmessage = (event: MessageEvent<JqRequest>) => {
  const { input, filter } = event.data
  let reply: JqReply
  try {
    reply = { outputs: jq.json(input as object, filter) }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    reply = { error: typeof stderr === "string" && stderr !== "" ? stderr : String(error) }
  }
  self.postMessage(reply)
}

self.postMessage("ready")

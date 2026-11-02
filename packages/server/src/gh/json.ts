import type { JqReply, JqRequest } from "./jq-worker"

/**
 * JSON as the GitHub CLI writes it. `--json` output goes through a Go `json.Encoder` with HTML escaping off;
 * `--jq` results go through `json.Marshal` (keys sorted, `<`, `>` and `&` escaped). Both escape U+2028 and U+2029,
 * which JSON.stringify leaves alone.
 */

const escapeLineSeparators = (json: string): string => json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")

/** `json.Encoder` with `SetEscapeHTML(false)`: the value's own key order, one trailing newline. */
export const encodeJson = (value: unknown): string => `${escapeLineSeparators(JSON.stringify(value))}\n`

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, sortKeysDeep(record[k])]))
  }
  return value
}

/** `json.Marshal` of a decoded value: sorted keys and HTML-safe escapes, no trailing newline. */
const marshal = (value: unknown): string =>
  escapeLineSeparators(JSON.stringify(sortKeysDeep(value)))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")

/** One `--jq` result as go-gh prints it: scalars raw (`null` as an empty line), anything else as compact JSON. */
const formatJqOutput = (value: unknown): string => {
  if (typeof value === "string") return `${value}\n`
  if (value === null) return "\n"
  if (typeof value === "boolean") return `${value}\n`
  if (typeof value === "number") return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}\n`
  return `${marshal(value)}\n`
}

/** A filter may run this long before its worker is stopped. */
const JQ_TIMEOUT_MS = 10_000

export type JqResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly stderr: string }

/** Runs `filter` over `value` on a fresh worker thread; a filter that runs past the timeout is stopped. */
export const evaluateJq = (value: unknown, filter: string): Promise<JqResult> => {
  const { promise, resolve } = Promise.withResolvers<JqResult>()
  const worker = new Worker(new URL("./jq-worker.ts", import.meta.url).href)
  const finish = (result: JqResult) => {
    clearTimeout(timer)
    worker.terminate()
    resolve(result)
  }
  const timer = setTimeout(
    () => finish({ ok: false, stderr: `jq: the filter ran for more than ${JQ_TIMEOUT_MS / 1000}s and was stopped\n` }),
    JQ_TIMEOUT_MS,
  )
  worker.onerror = (event) => finish({ ok: false, stderr: `jq: ${event.message}\n` })
  worker.onmessage = (event: MessageEvent<"ready" | JqReply>) => {
    const reply = event.data
    if (reply === "ready") {
      worker.postMessage({ input: value, filter } satisfies JqRequest)
      return
    }
    if ("error" in reply) finish({ ok: false, stderr: reply.error.endsWith("\n") ? reply.error : `${reply.error}\n` })
    else finish({ ok: true, stdout: reply.outputs.map(formatJqOutput).join("") })
  }
  return promise
}

import { ControlPaths, PairingPoll, PairingStart, PairingStartBody } from "@cloudagents/protocol"
import type { UserBox } from "@cloudagents/protocol"
import { Schema } from "effect"
import { hostname } from "node:os"
import { configPath, DEFAULT_CONFIG, loadConfig, writeConfig } from "./config"
import type { BoxConfig } from "./config"
import { CliError, openBrowser, sleep } from "./system"

const POLL_INTERVAL_MS = 3_000

export interface LoginOptions {
  readonly controlUrl?: string
  readonly name?: string
  readonly url?: string
  readonly force: boolean
}

const decodeAs = <A, I>(schema: Schema.Schema<A, I>, value: unknown, what: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch (error) {
    throw new CliError(`${what}: ${(error as Error).message}`)
  }
}

const expiredMessage = "pairing expired before it was approved; run `kestrel-box login` again"

/** Polls the control plane until this pairing is approved; returns the box and its secret. */
const awaitApproval = async (
  controlUrl: string,
  start: PairingStart,
): Promise<{ readonly box: UserBox; readonly secret: string }> => {
  const deadline = Date.parse(start.expiresAt)
  for (;;) {
    if (Date.now() >= deadline) throw new CliError(expiredMessage)
    await sleep(POLL_INTERVAL_MS)
    let response: Response
    try {
      response = await fetch(`${controlUrl}${ControlPaths.boxPairingPoll}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingId: start.pairingId }),
      })
    } catch (error) {
      console.error(`poll failed, retrying: ${(error as Error).message}`)
      continue
    }
    if (response.status === 404) throw new CliError(expiredMessage)
    if (response.status >= 500) {
      console.error(`control plane answered ${response.status}, retrying`)
      continue
    }
    if (!response.ok) throw new CliError(`pairing poll failed: ${response.status} ${await response.text()}`)
    const poll = decodeAs(PairingPoll, await response.json(), "pairing poll response")
    if (poll.status === "approved") return { box: poll.box, secret: poll.secret }
  }
}

export const login = async (options: LoginOptions): Promise<void> => {
  const existing = loadConfig()
  if (existing !== null && existing.boxId !== "" && !options.force) {
    console.log(`already paired as box ${existing.boxId} (${configPath()}).`)
    console.log("Run `kestrel-box install` to start it, or `kestrel-box login --force` to pair this machine again.")
    return
  }

  const base: BoxConfig = existing ?? DEFAULT_CONFIG
  const controlUrl = (options.controlUrl ?? base.controlUrl).replace(/\/+$/, "")
  const body = decodeAs(
    PairingStartBody,
    { name: (options.name ?? hostname()).trim(), url: options.url ?? `http://localhost:${base.port}` },
    "invalid --name or --url",
  )

  const startResponse = await fetch(`${controlUrl}${ControlPaths.boxPairing}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!startResponse.ok) throw new CliError(`pairing could not start: ${startResponse.status} ${await startResponse.text()}`)
  const start = decodeAs(PairingStart, await startResponse.json(), "pairing response")

  console.log(`Pairing code: ${start.code}`)
  console.log(`Approve this machine at: ${start.approveUrl}`)
  openBrowser(start.approveUrl)
  console.log("Waiting for approval...")

  const { box, secret } = await awaitApproval(controlUrl, start)
  writeConfig({ ...base, controlUrl, boxId: box.id, boxSecret: secret })
  console.log(`Paired as "${box.name}" (box ${box.id}). Config written to ${configPath()}.`)
  console.log("Next: kestrel-box install")
}

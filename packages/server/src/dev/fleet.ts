import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Schema } from "effect"
import { ControlPaths, CreatedFleetBox, FleetBox, FleetBoxList } from "@cloudagents/protocol"

/** The dev stack's managed box: what the box process runs with (`CLOUDAGENTS_BOX_ID`, `CLOUDAGENTS_BOX_SECRET`). */
export interface DevFleetBox {
  readonly id: string
  readonly secret: string
}

export interface DevFleetOptions {
  /** Origin of the local control plane (the Worker). */
  readonly workerUrl: string
  /** Where the box listens; the control plane calls it directly. */
  readonly boxUrl: string
  /** Name the dev box is registered under. */
  readonly name: string
  /** Where the box's id and secret are kept between runs, mode 600. */
  readonly savedFile: string
}

const SavedFleetBox = Schema.Struct({ id: Schema.String, secret: Schema.String })

/** Waits up to 60 seconds for the control plane to answer HTTP at all. */
const waitForWorker = async (workerUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetch(new URL(ControlPaths.me, workerUrl))
      return
    } catch {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 500)
      await promise
    }
  }
  throw new Error(`the control plane did not answer at ${workerUrl} within 60 seconds`)
}

/** Signs in through the dev-only `/auth/dev-login` and returns the session cookie for later calls. */
const devSignIn = async (workerUrl: string): Promise<string> => {
  const response = await fetch(new URL("/auth/dev-login", workerUrl), { redirect: "manual" })
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("session="))
  if (cookie === undefined) {
    throw new Error(`dev sign-in answered ${response.status}: is DEV_SESSION_LOGIN set in packages/control/.dev.vars?`)
  }
  return cookie.split(";")[0] ?? cookie
}

const callFleet = async <A, I>(
  workerUrl: string,
  cookie: string,
  method: string,
  path: string,
  schema: Schema.Schema<A, I>,
  body?: unknown,
): Promise<A> => {
  const response = await fetch(new URL(path, workerUrl), {
    method,
    headers: body === undefined ? { cookie } : { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const hint = response.status === 404 ? " (is the dev login in KESTREL_OPERATORS?)" : ""
    throw new Error(`${method} ${path} answered ${response.status}${hint}`)
  }
  return Schema.decodeUnknownPromise(schema)(await response.json())
}

/**
 * Makes sure the dev stack has one active managed box pointing at `boxUrl`, and returns its id and secret. Creates the
 * box when the control plane does not know the saved one, rotates the secret when the saved copy is lost, and
 * reactivates or re-points it when its state or URL differs.
 */
export const provisionDevFleetBox = async (options: DevFleetOptions): Promise<DevFleetBox> => {
  await waitForWorker(options.workerUrl)
  const cookie = await devSignIn(options.workerUrl)
  const call = <A, I>(method: string, path: string, schema: Schema.Schema<A, I>, body?: unknown) =>
    callFleet(options.workerUrl, cookie, method, path, schema, body)

  const saved = existsSync(options.savedFile)
    ? Schema.decodeUnknownSync(SavedFleetBox)(JSON.parse(readFileSync(options.savedFile, "utf8")))
    : null
  const { boxes } = await call("GET", ControlPaths.fleetBoxes, FleetBoxList)
  const existing = boxes.find((box) => box.id === saved?.id) ?? boxes.find((box) => box.name === options.name)

  let box: FleetBox
  let secret: string
  if (existing === undefined) {
    const created = await call("POST", ControlPaths.fleetBoxes, CreatedFleetBox, {
      name: options.name,
      url: options.boxUrl,
    })
    box = created.box
    secret = created.secret
  } else if (saved !== null && saved.id === existing.id) {
    box = existing
    secret = saved.secret
  } else {
    const rotated = await call("POST", ControlPaths.fleetBoxSecret(existing.id), CreatedFleetBox)
    box = rotated.box
    secret = rotated.secret
  }

  if (box.url !== options.boxUrl || box.state !== "active") {
    box = await call("PATCH", ControlPaths.fleetBox(box.id), FleetBox, { url: options.boxUrl, state: "active" })
  }

  mkdirSync(dirname(options.savedFile), { recursive: true })
  writeFileSync(options.savedFile, JSON.stringify({ id: box.id, secret }), { mode: 0o600 })
  return { id: box.id, secret }
}

import { Effect, Either, Schema } from "effect"
import {
  type AgentModel,
  Attachment,
  Automation,
  BOX_TOKEN_QUERY,
  BoxList,
  BoxStatus,
  BoxToken,
  CliAuthStatus,
  CliLoginCodeBody,
  CliLoginStart,
  CliProvider,
  Connection,
  ControlPaths,
  CreateBoxBody,
  CreatedBox,
  CreateTaskBody,
  DesktopStatus,
  DiffResponse,
  Health,
  HarnessCommands,
  Me,
  Message,
  Paths,
  PreviewSession,
  PutApiKeyBody,
  Run,
  RunItems,
  SendMessageBody,
  SendMessageResponse,
  SetActiveBoxBody,
  type SetDesktopQualityBody,
  Task,
  UpdateAutomationBody,
  UpdateBoxBody,
  UserBox,
  Usage,
} from "@cloudagents/protocol"
import { SERVER_URL, WS_URL } from "@/config"
import { APP_ORIGIN } from "@/routes"

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "ApiError"
  }
}

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/** Fires whenever any control-plane call is rejected with 401 (session missing or expired). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function errorMessage(text: string, fallback: string): string {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return body.message
    }
  } catch {
    // Body is not JSON; fall through to raw text.
  }
  return text || fallback
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

/**
 * One HTTP exchange decoded with `schema`. `session` marks control-plane calls: they carry the app session cookie and
 * report a 401 to the unauthorized listeners. Box calls carry `headers` (the box token) and no cookie.
 * `body`: a `Blob` (e.g. a `File`) is sent as raw bytes with its own type; anything else as JSON.
 */
const send = <A, I>(
  schema: Schema.Schema<A, I>,
  method: Method,
  url: string,
  body: unknown,
  session: boolean,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<A, ApiError> =>
  Effect.gen(function* () {
    const contentType =
      body === undefined ? undefined : body instanceof Blob ? body.type || "application/octet-stream" : "application/json"
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method,
          credentials: session ? "include" : "omit",
          headers: contentType === undefined ? headers : { ...headers, "content-type": contentType },
          body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
        }),
      catch: (e) => new ApiError(0, `Cannot reach server at ${new URL(url).origin}: ${String(e)}`),
    })
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => new ApiError(res.status, String(e)),
    })
    if (session && res.status === 401) {
      unauthorizedListeners.forEach((listener) => listener())
    }
    if (!res.ok) {
      return yield* Effect.fail(new ApiError(res.status, errorMessage(text, res.statusText)))
    }
    // 204 and other empty bodies carry no JSON; they decode as `undefined`.
    const json = yield* Effect.try({
      try: () => (text === "" ? undefined : (JSON.parse(text) as unknown)),
      catch: () => new ApiError(res.status, "Server returned invalid JSON"),
    })
    return yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError((e) => new ApiError(res.status, `Unexpected response shape: ${e.message}`)),
    )
  })

/** A control-plane call: served by the Worker with the app session. */
const request = <A, I>(
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body?: unknown,
): Effect.Effect<A, ApiError> => send(schema, method, SERVER_URL + path, body, true)

const run = <A>(effect: Effect.Effect<A, ApiError>): Promise<A> =>
  Effect.runPromise(Effect.either(effect)).then((result) => {
    if (Either.isLeft(result)) throw result.left
    return result.right
  })

/** The user box that box calls go to, or `null` for Kestrel's relayed box. Undefined until the box list is read. */
type DirectRoute = { readonly boxId: string; readonly url: string }
let route: DirectRoute | null | undefined

/** Box tokens are re-minted this long before they expire, so a call never leaves with a token about to lapse. */
const TOKEN_REFRESH_MS = 60_000

const tokens = new Map<string, { readonly token: string; readonly refreshAt: number }>()
const minting = new Map<string, Promise<string>>()

/** Makes the list's active box the target of box calls. Its URL is the box's own, from the list. */
function adoptBoxList(list: BoxList): BoxList {
  const active = list.boxes.find((box) => box.id === list.activeBoxId)
  route = active === undefined ? null : { boxId: active.id, url: active.url }
  return list
}

async function loadBoxes(): Promise<BoxList> {
  return adoptBoxList(await run(request(BoxList, "GET", ControlPaths.boxes)))
}

async function activeRoute(): Promise<DirectRoute | null> {
  if (route === undefined) await loadBoxes()
  return route ?? null
}

/** A box token for `boxId`: cached until shortly before it expires, with one mint in flight per box. */
function boxToken(boxId: string): Promise<string> {
  const cached = tokens.get(boxId)
  if (cached !== undefined && Date.now() < cached.refreshAt) return Promise.resolve(cached.token)
  const pending = minting.get(boxId)
  if (pending !== undefined) return pending
  const mint = run(request(BoxToken, "POST", ControlPaths.userBoxToken(boxId)))
    .then((issued) => {
      tokens.set(boxId, { token: issued.token, refreshAt: Date.parse(issued.expiresAt) - TOKEN_REFRESH_MS })
      return issued.token
    })
    .finally(() => minting.delete(boxId))
  minting.set(boxId, mint)
  return mint
}

/** Drops the cached token of a box, after its secret changed or its token was refused. */
function forgetBox(boxId: string): void {
  tokens.delete(boxId)
}

/** The active user box with a token for it, or `null` when Kestrel's relayed box is active. */
async function directBox(): Promise<(DirectRoute & { readonly token: string }) | null> {
  const active = await activeRoute()
  if (active === null) return null
  return { ...active, token: await boxToken(active.boxId) }
}

/**
 * A call the box serves. On Kestrel's box it goes through the Worker like any control call. On a user's box it goes
 * straight to the box's URL with a box token; a 401 means the token was refused, so it is minted again and the call
 * is retried once.
 */
const boxRequest = <A, I>(
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body?: unknown,
  retried = false,
): Effect.Effect<A, ApiError> =>
  Effect.gen(function* () {
    const box = yield* Effect.tryPromise({
      try: () => directBox(),
      catch: (e) => (e instanceof ApiError ? e : new ApiError(0, String(e))),
    })
    if (box === null) return yield* request(schema, method, path, body)
    return yield* send(schema, method, box.url + path, body, false, { authorization: `Bearer ${box.token}` }).pipe(
      Effect.catchAll((e) => {
        if (e.status !== 401 || retried) return Effect.fail(e)
        forgetBox(box.boxId)
        return boxRequest(schema, method, path, body, true)
      }),
    )
  })

const OFFLINE: BoxStatus = { online: false, connectedAt: null, boxVersion: null }

/**
 * A user box's status from its own `Paths.health`, read without credentials: any failure to answer means offline.
 * The box has no relay connection, so `connectedAt` stays null.
 */
async function checkBox(url: string): Promise<BoxStatus> {
  try {
    const res = await fetch(url + Paths.health)
    if (!res.ok) return OFFLINE
    const health = Schema.decodeUnknownSync(Health)(await res.json())
    return { online: true, connectedAt: null, boxVersion: health.version }
  } catch {
    return OFFLINE
  }
}

/**
 * Absolute URL of a WebSocket path: through the Worker, or straight to the active box with its token in the query.
 */
export async function socketUrl(path: string): Promise<string> {
  const box = await directBox()
  if (box === null) return WS_URL + path
  const url = new URL(path, box.url.replace(/^http/, "ws"))
  url.searchParams.set(BOX_TOKEN_QUERY, box.token)
  return url.toString()
}

/**
 * Absolute URL of an attachment. An `<img>` or link loads it with the session cookie through the Worker, or with the
 * box token in the query when the box is direct.
 */
export async function attachmentUrl(taskId: string, attachmentId: string): Promise<string> {
  const path = Paths.taskAttachment(taskId, attachmentId)
  const box = await directBox()
  if (box === null) return SERVER_URL + path
  const url = new URL(path, box.url)
  url.searchParams.set(BOX_TOKEN_QUERY, box.token)
  return url.toString()
}

/**
 * On the public site: who is signed in on the app host, or null. Reaches the app host directly (the public hosts
 * only redirect `/api`), and treats any failure as signed out without firing the unauthorized listeners.
 */
export async function signedInUser(): Promise<Me | null> {
  try {
    const res = await fetch(APP_ORIGIN + ControlPaths.me, { credentials: "include" })
    return res.ok ? Schema.decodeUnknownSync(Me)(await res.json()) : null
  } catch {
    return null
  }
}

/**
 * Pending upload id of each `File` already stored on a task. A failed send leaves its uploads pending on the box (they
 * are consumed only with the message), so a resend of the same `File` reuses the id instead of storing it again.
 */
const pendingUploads = new WeakMap<File, { readonly taskId: string; readonly id: string }>()

/** Uploads `file` to the task unless it already waits there; the id is kept as soon as its own upload succeeds. */
const uploadOnce = async (taskId: string, file: File): Promise<string> => {
  const pending = pendingUploads.get(file)
  if (pending?.taskId === taskId) return pending.id
  const { id } = await run(
    boxRequest(Attachment, "POST", `${Paths.taskUploads(taskId)}?name=${encodeURIComponent(file.name)}`, file),
  )
  pendingUploads.set(file, { taskId, id })
  return id
}

export const api = {
  // Control plane (served by the Worker).
  me: () => run(request(Me, "GET", ControlPaths.me)),
  logout: () => run(Effect.asVoid(request(Schema.Unknown, "POST", ControlPaths.logout))),
  connections: () => run(request(Schema.Array(Connection), "GET", ControlPaths.connections)),
  putApiKey: (provider: string, body: PutApiKeyBody) =>
    run(request(Connection, "PUT", ControlPaths.connection(provider), body)),
  deleteConnection: (provider: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)))),
  listAutomations: () => run(request(Schema.Array(Automation), "GET", ControlPaths.automations)),
  updateAutomation: (id: string, body: UpdateAutomationBody) =>
    run(request(Automation, "PATCH", ControlPaths.automation(id), body)),
  deleteAutomation: (id: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.automation(id)))),

  /** The user's boxes; reading them also makes the active one the target of box calls. */
  boxes: loadBoxes,
  createBox: (body: CreateBoxBody) => run(request(CreatedBox, "POST", ControlPaths.boxes, body)),
  updateBox: async (id: string, body: UpdateBoxBody): Promise<BoxList> => {
    await run(request(UserBox, "PATCH", ControlPaths.userBox(id), body))
    forgetBox(id)
    return loadBoxes()
  },
  deleteBox: async (id: string): Promise<BoxList> => {
    await run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.userBox(id))))
    forgetBox(id)
    return loadBoxes()
  },
  regenerateBoxSecret: async (id: string): Promise<CreatedBox> => {
    const created = await run(request(CreatedBox, "POST", ControlPaths.userBoxSecret(id)))
    forgetBox(id)
    return created
  },
  setActiveBox: async (boxId: string | null): Promise<BoxList> => {
    const body: SetActiveBoxBody = { boxId }
    return adoptBoxList(await run(request(BoxList, "PUT", ControlPaths.activeBox, body)))
  },
  checkBox,
  /** Status of the box the apps talk to: Kestrel's relayed box, or the active user box's own health. */
  boxStatus: async (): Promise<BoxStatus> => {
    const active = await activeRoute()
    return active === null ? run(request(BoxStatus, "GET", ControlPaths.box)) : checkBox(active.url)
  },

  // Agent box (served by the box: relayed by the Worker, or direct).
  cliAuth: () => run(boxRequest(Schema.Array(CliAuthStatus), "GET", ControlPaths.cliAuth)),
  cliLoginStart: (provider: CliProvider) =>
    run(boxRequest(CliLoginStart, "POST", ControlPaths.cliLogin(provider))),
  cliLoginCode: (provider: CliProvider, body: CliLoginCodeBody) =>
    run(boxRequest(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body)),
  cliLogout: (provider: CliProvider) =>
    run(Effect.asVoid(boxRequest(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider)))),
  attachmentUrl,
  /**
   * The sandboxed preview document of a thread. The box mints the session; the frame is served from the box's URL
   * when a user box is active, and from the app's own origin otherwise.
   */
  previewFrame: async (taskId: string): Promise<string> => {
    const active = await activeRoute()
    const session = await run(boxRequest(PreviewSession, "POST", Paths.taskPreviewSession(taskId), {}))
    return (active?.url ?? "") + Paths.taskPreviewFrame(session.token, taskId)
  },

  usage: () => run(boxRequest(Usage, "GET", Paths.usage)),
  listTasks: () => run(boxRequest(Schema.Array(Task), "GET", Paths.tasks)),
  createTask: (body: CreateTaskBody) => run(boxRequest(Task, "POST", Paths.tasks, body)),
  getTask: (taskId: string) => run(boxRequest(Task, "GET", Paths.task(taskId))),
  archiveTask: (taskId: string) => run(boxRequest(Task, "POST", Paths.taskArchive(taskId))),
  unarchiveTask: (taskId: string) => run(boxRequest(Task, "DELETE", Paths.taskArchive(taskId))),
  listMessages: (taskId: string) => run(boxRequest(Schema.Array(Message), "GET", Paths.taskMessages(taskId))),
  /** Slash commands of the harness for the composer's chosen model in this thread. */
  commands: (taskId: string, model: AgentModel) =>
    run(boxRequest(HarnessCommands, "GET", `${Paths.taskCommands(taskId)}?model=${encodeURIComponent(model)}`)),
  /**
   * Uploads `files` to the task, then sends the message with them attached after any ids already in `body`.
   * A resend after a failure uploads only the files that are not on the task yet.
   */
  sendMessage: async (taskId: string, body: SendMessageBody, files: readonly File[] = []) => {
    const uploaded = await Promise.all(files.map((file) => uploadOnce(taskId, file)))
    const attachments = [...(body.attachments ?? []), ...uploaded]
    const sent = await run(
      boxRequest(
        SendMessageResponse,
        "POST",
        Paths.taskMessages(taskId),
        attachments.length > 0 ? { ...body, attachments } : body,
      ),
    )
    // Sent ids are no longer pending; attaching the same `File` again must upload it anew.
    for (const file of files) pendingUploads.delete(file)
    return sent
  },
  listRuns: (taskId: string) => run(boxRequest(Schema.Array(Run), "GET", Paths.taskRuns(taskId))),
  runItems: (runId: string) => run(boxRequest(RunItems, "GET", Paths.runItems(runId))),
  cancelRun: (runId: string) => run(boxRequest(Run, "POST", Paths.runCancel(runId))),
  getDiff: (taskId: string) => run(boxRequest(DiffResponse, "GET", Paths.taskDiff(taskId))),
  getDesktop: (taskId: string) => run(boxRequest(DesktopStatus, "GET", Paths.taskDesktop(taskId))),
  startDesktop: (taskId: string) => run(boxRequest(DesktopStatus, "POST", Paths.taskDesktop(taskId))),
  stopDesktop: (taskId: string) =>
    run(Effect.asVoid(boxRequest(Schema.Unknown, "DELETE", Paths.taskDesktop(taskId)))),
  setDesktopQuality: (taskId: string, body: SetDesktopQualityBody) =>
    run(boxRequest(DesktopStatus, "PUT", Paths.taskDesktopQuality(taskId), body)),
}

import { Effect, Either, Schema } from "effect"
import {
  type AgentModel,
  ApprovePairingBody,
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
  PendingPairing,
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

/** A user box the apps call directly: its id and URL. Box calls to it carry a box token. */
type DirectRoute = { readonly boxId: string; readonly url: string }

/** Where a box call goes: a user box directly, or `null` for Kestrel's relayed box (through the Worker). */
export type Target = DirectRoute | null

/** The box list as last read. Undefined until the first read. */
let known: BoxList | undefined

/**
 * The box each thread lives on, by thread id: a user box's id, or `null` for Kestrel's relayed box. Filled by the
 * thread lists and by `createTask`. A thread missing from it is found by reading every box's thread list again.
 */
const taskBoxes = new Map<string, string | null>()

/** A box's thread list that takes longer than this is left out, so one slow box cannot hold up the others. */
const BOX_LIST_TIMEOUT_MS = 10_000

/** Box tokens are re-minted this long before they expire, so a call never leaves with a token about to lapse. */
const TOKEN_REFRESH_MS = 60_000

const tokens = new Map<string, { readonly token: string; readonly refreshAt: number }>()
const minting = new Map<string, Promise<string>>()

function adoptBoxList(list: BoxList): BoxList {
  known = list
  return list
}

async function loadBoxes(): Promise<BoxList> {
  return adoptBoxList(await run(request(BoxList, "GET", ControlPaths.boxes)))
}

/** The target of a box id in the last box list read; undefined when that list has no such box. */
function routeOf(boxId: string | null): Target | undefined {
  if (boxId === null) return null
  const box = known?.boxes.find((b) => b.id === boxId)
  return box === undefined ? undefined : { boxId, url: box.url }
}

/**
 * The target of calls that are not about one thread: the active box. When the box list cannot be read, calls go to
 * Kestrel's box (the default for everyone who has not picked their own) and the list is read again on the next call,
 * so a control-plane error never stops the app.
 */
async function activeTarget(): Promise<Target> {
  if (known === undefined) await loadBoxes().catch(() => undefined)
  return routeOf(known?.activeBoxId ?? null) ?? null
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

/**
 * A call the box serves. Kestrel's box is called through the Worker like any control call. A user box is called
 * straight at its URL with a box token; a 401 means the token was refused, so it is minted again and the call is
 * retried once.
 */
const boxCall = <A, I>(
  target: Target,
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body?: unknown,
  retried = false,
): Effect.Effect<A, ApiError> => {
  if (target === null) return request(schema, method, path, body)
  return Effect.flatMap(
    Effect.tryPromise({
      try: () => boxToken(target.boxId),
      catch: (e) => (e instanceof ApiError ? e : new ApiError(0, String(e))),
    }),
    (token) =>
      send(schema, method, target.url + path, body, false, { authorization: `Bearer ${token}` }).pipe(
        Effect.catchAll((e) => {
          if (e.status !== 401 || retried) return Effect.fail(e)
          forgetBox(target.boxId)
          return boxCall(target, schema, method, path, body, true)
        }),
      ),
  )
}

/** A box call on the box a thread lives on. */
function onTask<A, I>(
  taskId: string,
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body?: unknown,
): Promise<A> {
  return taskTarget(taskId).then((target) => run(boxCall(target, schema, method, path, body)))
}

/** A box call on the active box: where new threads start, and the source of box-level state. */
function onActive<A, I>(schema: Schema.Schema<A, I>, method: Method, path: string, body?: unknown): Promise<A> {
  return activeTarget().then((target) => run(boxCall(target, schema, method, path, body)))
}

/**
 * The box a thread lives on. A thread not seen yet is found by reading every box's thread list, so a thread opened
 * straight from a link works before the list is loaded.
 */
export async function taskTarget(taskId: string): Promise<Target> {
  const cached = taskBoxes.get(taskId)
  const cachedTarget = cached === undefined ? undefined : routeOf(cached)
  if (cachedTarget !== undefined) return cachedTarget
  await listAllTasks()
  const boxId = taskBoxes.get(taskId)
  const target = boxId === undefined ? undefined : routeOf(boxId)
  if (target === undefined) throw new ApiError(404, "Thread not found")
  return target
}

let listing: Promise<Task[]> | undefined

/** Every box's threads, merged. Concurrent callers share one read. */
function listAllTasks(): Promise<Task[]> {
  listing ??= readAllTasks().finally(() => {
    listing = undefined
  })
  return listing
}

/**
 * Reads the thread list of Kestrel's box and of every user box at once, and records which box owns each thread. A box
 * that fails or times out is left out; the read fails only when no box answers.
 */
async function readAllTasks(): Promise<Task[]> {
  const boxes = (await loadBoxes().catch(() => known))?.boxes ?? []
  const targets: Target[] = [null, ...boxes.map((box) => ({ boxId: box.id, url: box.url }))]
  const results = await Promise.allSettled(
    targets.map((target) =>
      withTimeout(run(boxCall(target, Schema.Array(Task), "GET", Paths.tasks)), BOX_LIST_TIMEOUT_MS).then(
        (tasks) => ({ boxId: target?.boxId ?? null, tasks }),
      ),
    ),
  )
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed.length === results.length) throw failed[0]?.reason
  const merged: Task[] = []
  for (const result of results) {
    if (result.status === "rejected") continue
    const { boxId, tasks } = result.value
    for (const [id, owner] of taskBoxes) if (owner === boxId) taskBoxes.delete(id)
    for (const task of tasks) {
      taskBoxes.set(task.id, boxId)
      merged.push(task)
    }
  }
  return merged
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new ApiError(0, "The box did not answer in time")), ms)
  })
  return Promise.race([promise, expired]).finally(() => window.clearTimeout(timer))
}

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
 * Absolute URL of a WebSocket path on `target`: through the Worker, or straight to a user box with its token in the
 * query.
 */
export async function socketUrl(path: string, target: Target): Promise<string> {
  if (target === null) return WS_URL + path
  const url = new URL(path, target.url.replace(/^http/, "ws"))
  url.searchParams.set(BOX_TOKEN_QUERY, await boxToken(target.boxId))
  return url.toString()
}

/**
 * Absolute URL of an attachment of a thread. An `<img>` or link loads it with the session cookie through the Worker,
 * or with the box token in the query when the thread's box is a user box.
 */
export async function attachmentUrl(taskId: string, attachmentId: string): Promise<string> {
  const path = Paths.taskAttachment(taskId, attachmentId)
  const target = await taskTarget(taskId)
  if (target === null) return SERVER_URL + path
  const url = new URL(path, target.url)
  url.searchParams.set(BOX_TOKEN_QUERY, await boxToken(target.boxId))
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
  const { id } = await onTask(
    taskId,
    Attachment,
    "POST",
    `${Paths.taskUploads(taskId)}?name=${encodeURIComponent(file.name)}`,
    file,
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
  /** The pending pairing of a code the CLI showed, for the approval page; 404 when unknown or expired. */
  pendingPairing: (code: string) => run(request(PendingPairing, "GET", ControlPaths.pairing(code))),
  /** Approves a pairing: creates the box, made active when `activate`. Returns the box list, like `setActiveBox`. */
  approvePairing: async (code: string, body: ApprovePairingBody): Promise<BoxList> =>
    adoptBoxList(await run(request(BoxList, "POST", ControlPaths.pairingApprove(code), body))),
  checkBox,
  /** Status of the box the apps talk to: Kestrel's relayed box, or the active user box's own health. */
  boxStatus: async (): Promise<BoxStatus> => {
    const target = await activeTarget()
    return target === null ? run(request(BoxStatus, "GET", ControlPaths.box)) : checkBox(target.url)
  },

  // Agent box: box-level state comes from the active box; everything about a thread comes from the thread's own box.
  cliAuth: () => onActive(Schema.Array(CliAuthStatus), "GET", ControlPaths.cliAuth),
  cliLoginStart: (provider: CliProvider) => onActive(CliLoginStart, "POST", ControlPaths.cliLogin(provider)),
  cliLoginCode: (provider: CliProvider, body: CliLoginCodeBody) =>
    onActive(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body),
  cliLogout: async (provider: CliProvider): Promise<void> => {
    await onActive(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider))
  },
  attachmentUrl,
  /**
   * The sandboxed preview document of a thread. It is served from the thread's box: a user box's URL, or the app's own
   * origin for Kestrel's box.
   */
  previewFrame: async (taskId: string): Promise<string> => {
    const target = await taskTarget(taskId)
    const session = await run(boxCall(target, PreviewSession, "POST", Paths.taskPreviewSession(taskId), {}))
    return (target?.url ?? "") + Paths.taskPreviewFrame(session.token, taskId)
  },

  usage: () => onActive(Usage, "GET", Paths.usage),
  /** Every box's threads, merged; a box that does not answer is left out unless none does. */
  listTasks: listAllTasks,
  createTask: async (body: CreateTaskBody): Promise<Task> => {
    const target = await activeTarget()
    const task = await run(boxCall(target, Task, "POST", Paths.tasks, body))
    taskBoxes.set(task.id, target?.boxId ?? null)
    return task
  },
  getTask: (taskId: string) => onTask(taskId, Task, "GET", Paths.task(taskId)),
  archiveTask: (taskId: string) => onTask(taskId, Task, "POST", Paths.taskArchive(taskId)),
  unarchiveTask: (taskId: string) => onTask(taskId, Task, "DELETE", Paths.taskArchive(taskId)),
  listMessages: (taskId: string) => onTask(taskId, Schema.Array(Message), "GET", Paths.taskMessages(taskId)),
  /** Slash commands of the harness for the composer's chosen model in this thread. */
  commands: (taskId: string, model: AgentModel) =>
    onTask(taskId, HarnessCommands, "GET", `${Paths.taskCommands(taskId)}?model=${encodeURIComponent(model)}`),
  /**
   * Uploads `files` to the task, then sends the message with them attached after any ids already in `body`.
   * A resend after a failure uploads only the files that are not on the task yet.
   */
  sendMessage: async (taskId: string, body: SendMessageBody, files: readonly File[] = []) => {
    const uploaded = await Promise.all(files.map((file) => uploadOnce(taskId, file)))
    const attachments = [...(body.attachments ?? []), ...uploaded]
    const sent = await onTask(
      taskId,
      SendMessageResponse,
      "POST",
      Paths.taskMessages(taskId),
      attachments.length > 0 ? { ...body, attachments } : body,
    )
    // Sent ids are no longer pending; attaching the same `File` again must upload it anew.
    for (const file of files) pendingUploads.delete(file)
    return sent
  },
  listRuns: (taskId: string) => onTask(taskId, Schema.Array(Run), "GET", Paths.taskRuns(taskId)),
  runItems: (taskId: string, runId: string) => onTask(taskId, RunItems, "GET", Paths.runItems(runId)),
  cancelRun: (taskId: string, runId: string) => onTask(taskId, Run, "POST", Paths.runCancel(runId)),
  getDiff: (taskId: string) => onTask(taskId, DiffResponse, "GET", Paths.taskDiff(taskId)),
  getDesktop: (taskId: string) => onTask(taskId, DesktopStatus, "GET", Paths.taskDesktop(taskId)),
  startDesktop: (taskId: string) => onTask(taskId, DesktopStatus, "POST", Paths.taskDesktop(taskId)),
  stopDesktop: async (taskId: string): Promise<void> => {
    await onTask(taskId, Schema.Unknown, "DELETE", Paths.taskDesktop(taskId))
  },
  setDesktopQuality: (taskId: string, body: SetDesktopQualityBody) =>
    onTask(taskId, DesktopStatus, "PUT", Paths.taskDesktopQuality(taskId), body),
}

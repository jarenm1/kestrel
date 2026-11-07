import { Effect, Either, Schema } from "effect"
import {
  type AgentModel,
  ApprovePairingBody,
  Attachment,
  Automation,
  BOX_TOKEN_QUERY,
  BoxCapabilities,
  BoxList,
  BoxStatus,
  BoxToken,
  CliAuthStatus,
  CliLoginCodeBody,
  CliLoginStart,
  CliProvider,
  Connection,
  connectionsForBox,
  ControlPaths,
  CreateBoxBody,
  CreateFleetBoxBody,
  CreateNestBoxBody,
  CreateAutomationBody,
  CreatedBox,
  CreatedFleetBox,
  CreateTaskBody,
  DesktopStatus,
  DiffResponse,
  type FileRoot,
  FilesResponse,
  MAX_RELAY_RESPONSE_BYTES,
  GithubRepo,
  Health,
  HarnessCommands,
  FleetBox,
  FleetBoxList,
  FleetActivity,
  Me,
  Message,
  ModelCatalog,
  type ModelProvider,
  NestHostList,
  Paths,
  ProviderUsage,
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
  TextGenerationSettings,
  type ThreadPullRequestAction,
  ThreadPullRequestDetail,
  ThreadPullRequestDiff,
  ThreadPullRequests,
  ThreadSettings,
  ToolFailureList,
  UpdateAutomationBody,
  UpdateBoxBody,
  UpdateFleetBoxBody,
  UserBox,
  Usage,
  UsageActivity,
  type UseBankedResetBody,
  UseBankedResetResult,
} from "@cloudagents/protocol"
import { SERVER_URL, WS_URL } from "@/config"
import { APP_ORIGIN } from "@/routes"
import { type BoxChannel, ChannelUnsent, channelFor, closeChannels } from "./rtc"
import { ApiError, responseError } from "./errors"

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/** Fires whenever any control-plane call is rejected with 401 (session missing or expired). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

/** Decodes one exchange: a non-2xx status fails with the server's message; a 2xx body is decoded with `schema`. */
const decodeExchange = <A, I>(
  schema: Schema.Schema<A, I>,
  status: number,
  statusText: string,
  text: string,
): Effect.Effect<A, ApiError> =>
  Effect.gen(function* () {
    if (status < 200 || status > 299) return yield* Effect.fail(responseError(status, text, statusText))
    // 204 and other empty bodies carry no JSON; they decode as `undefined`.
    const json = yield* Effect.try({
      try: () => (text === "" ? undefined : (JSON.parse(text) as unknown)),
      catch: () => new ApiError(status, "Server returned invalid JSON"),
    })
    return yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError((e) => new ApiError(status, `Unexpected response shape: ${e.message}`)),
    )
  })

/** A box call over an open data channel: the box's reply decoded exactly as an HTTP response would be. */
const viaChannel = <A, I>(
  channel: BoxChannel,
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body: unknown,
): Effect.Effect<A, ApiError | ChannelUnsent> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: () => channel.request(method, path, body),
      catch: (e) => (e instanceof ChannelUnsent ? e : new ApiError(0, e instanceof Error ? e.message : String(e))),
    }),
    (reply) => decodeExchange(schema, reply.status, "", reply.body),
  )

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
      closeChannels()
      unauthorizedListeners.forEach((listener) => listener())
    }
    return yield* decodeExchange(schema, res.status, res.statusText, text)
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

/**
 * The target of a box id in the last box list read; undefined when that list has no such box. `null` is Kestrel's box,
 * which is the managed box while one is assigned (see `kestrelTarget`).
 */
function routeOf(boxId: string | null): Target | undefined {
  if (boxId === null) return kestrelTarget()
  if (known?.managedBox?.id === boxId) return { boxId, url: known.managedBox.url }
  const box = known?.boxes.find((b) => b.id === boxId)
  return box === undefined ? undefined : { boxId, url: box.url }
}

/**
 * Kestrel's box as the last box list read has it: the managed box the user is assigned to, reached directly, or `null`
 * (the legacy relay) while there is none.
 */
function kestrelTarget(): Target {
  const managed = known?.managedBox
  return managed ? { boxId: managed.id, url: managed.url } : null
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

/** A Nest box's owner action. Its URL can change (a parked box resumes on another host), so its token is dropped and the list read again. */
async function nestAction(id: string, path: string): Promise<BoxList> {
  await run(Effect.asVoid(request(Schema.Unknown, "POST", path)))
  forgetBox(id)
  return loadBoxes()
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
    (token) => {
      // A body that is a Blob (a file upload) always goes over HTTP; everything else prefers the open channel.
      const channel = body instanceof Blob ? null : channelFor(target.boxId, target.url, token)
      const overHttp = () => send(schema, method, target.url + path, body, false, { authorization: `Bearer ${token}` })
      const call =
        channel === null
          ? overHttp()
          : viaChannel(channel, schema, method, path, body).pipe(
              // The channel never delivered the request to the box, so this call goes over HTTP instead.
              Effect.catchAll((e) => (e instanceof ChannelUnsent ? overHttp() : Effect.fail(e))),
            )
      return call.pipe(
        Effect.catchAll((e) => {
          if (e.status !== 401 || retried) return Effect.fail(e)
          forgetBox(target.boxId)
          return boxCall(target, schema, method, path, body, true)
        }),
      )
    },
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
 * A box call pinned to a box from the last box list read, so a later active-box switch cannot retarget it. `null` is
 * the legacy relay (no managed box); callers with a managed box pass its id instead.
 */
function onBox<A, I>(
  boxId: string | null,
  schema: Schema.Schema<A, I>,
  method: Method,
  path: string,
  body?: unknown,
): Promise<A> {
  const target = routeOf(boxId)
  return target === undefined
    ? Promise.reject(new ApiError(404, "That box is no longer in your box list", "BoxNotFound"))
    : run(boxCall(target, schema, method, path, body))
}

/** What `connectionsForBox` needs from one box: its CLI logins and the harnesses it can launch. */
type BoxConnectionSource = {
  readonly cliAuth: readonly CliAuthStatus[] | undefined
  readonly harnesses: readonly ModelProvider[] | undefined
  readonly error?: string
}

/**
 * The box-level half of the connections list, read from one captured target so a box switch mid-call cannot mix two
 * boxes. A box too old to report capabilities (404) still reports CLI logins: its native sign-ins stay usable while
 * no harness is offered. Any other failure marks the whole box unavailable, so a network error can never expose a
 * harness the box did not confirm.
 */
async function boxConnectionSource(target: Target): Promise<BoxConnectionSource> {
  let cliAuth: readonly CliAuthStatus[]
  try {
    cliAuth = await run(boxCall(target, Schema.Array(CliAuthStatus), "GET", ControlPaths.cliAuthFor(CliProvider.literals)))
  } catch (error) {
    return {
      cliAuth: undefined,
      harnesses: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    const capabilities = await run(boxCall(target, BoxCapabilities, "GET", Paths.capabilities))
    return { cliAuth, harnesses: capabilities.harnesses }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { cliAuth, harnesses: undefined }
    return {
      cliAuth: undefined,
      harnesses: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
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
  const targets: Target[] = [kestrelTarget(), ...boxes.map((box) => ({ boxId: box.id, url: box.url }))]
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
    for (const [id, owner] of taskBoxes) if ((owner ?? kestrelTarget()?.boxId ?? null) === boxId) taskBoxes.delete(id)
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

/** A box's status: the relayed status for Kestrel's relayed box, else the box's own health. */
function statusOf(target: Target): Promise<BoxStatus> {
  return target === null ? run(request(BoxStatus, "GET", ControlPaths.box)) : checkBox(target.url)
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
 * Absolute URL of a file a thread's box serves (`Paths.taskAttachment`, `Paths.taskCheckoutIcon`). An `<img>` or link
 * loads it with the session cookie through the Worker, or with the box token in the query when the thread's box is a
 * user box.
 */
export async function taskFileUrl(taskId: string, path: string): Promise<string> {
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
  /**
   * Stored accounts and keys from the Worker, with the CLI logins and harness availability of the active box. The box
   * is captured once, so rows always describe one box; a box that cannot answer leaves the stored accounts manageable
   * and marks its CLI rows unavailable.
   */
  connections: async () => {
    const stored = await run(request(Schema.Array(Connection), "GET", ControlPaths.connections))
    const target = await activeTarget()
    return connectionsForBox(stored, await boxConnectionSource(target))
  },
  putApiKey: (provider: string, body: PutApiKeyBody) =>
    run(request(Connection, "PUT", ControlPaths.connection(provider), body)),
  deleteConnection: (provider: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)))),
  listAutomations: () => run(request(Schema.Array(Automation), "GET", ControlPaths.automations)),
  createAutomation: (body: CreateAutomationBody) =>
    run(request(Automation, "POST", ControlPaths.automations, body)),
  /** Repositories the user's GitHub connection can read, most recently updated first. 404 when GitHub is not connected. */
  githubRepos: () => run(request(Schema.Array(GithubRepo), "GET", ControlPaths.githubRepos)),
  /** One repository ("owner/name") the GitHub connection can read; 404 when GitHub is not connected or it is not visible. */
  githubRepo: (repo: string) => run(request(GithubRepo, "GET", ControlPaths.githubRepo(repo))),
  /** Branch names of a repository ("owner/name") the GitHub connection can read, the default branch first. */
  githubBranches: (repo: string) => run(request(Schema.Array(Schema.String), "GET", ControlPaths.githubBranches(repo))),
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
  /** Nest boxes: creates one for the user and answers with the box list as it now stands. */
  createNestBox: async (body: CreateNestBoxBody): Promise<BoxList> => {
    await run(Effect.asVoid(request(Schema.Unknown, "POST", ControlPaths.nestBoxes, body)))
    return loadBoxes()
  },
  resumeNestBox: (id: string) => nestAction(id, ControlPaths.nestBoxResume(id)),
  suspendNestBox: (id: string) => nestAction(id, ControlPaths.nestBoxSuspend(id)),
  parkNestBox: (id: string) => nestAction(id, ControlPaths.nestBoxPark(id)),
  attachNestGpu: (id: string) => nestAction(id, ControlPaths.nestBoxGpuAttach(id)),
  detachNestGpu: (id: string) => nestAction(id, ControlPaths.nestBoxGpuDetach(id)),
  /** Operator-only: Nest hosts and their capacity, as the fleet page lists them. */
  nestHosts: () => run(request(NestHostList, "GET", ControlPaths.nestHosts)),
  setActiveBox: async (boxId: string | null): Promise<BoxList> => {
    const body: SetActiveBoxBody = { boxId }
    return adoptBoxList(await run(request(BoxList, "PUT", ControlPaths.activeBox, body)))
  },
  /** The pending pairing of a code the CLI showed, for the approval page; 404 when unknown or expired. */
  pendingPairing: (code: string) => run(request(PendingPairing, "GET", ControlPaths.pairing(code))),
  /** Approves a pairing: creates the box, made active when `activate`. Returns the box list, like `setActiveBox`. */
  approvePairing: async (code: string, body: ApprovePairingBody): Promise<BoxList> =>
    adoptBoxList(await run(request(BoxList, "POST", ControlPaths.pairingApprove(code), body))),
  /** Operator-only: Kestrel's managed boxes, as the fleet page lists them. */
  fleetBoxes: () => run(request(FleetBoxList, "GET", ControlPaths.fleetBoxes)),
  fleetActivity: () => run(request(FleetActivity, "GET", ControlPaths.fleetActivity)),
  createFleetBox: (body: CreateFleetBoxBody) => run(request(CreatedFleetBox, "POST", ControlPaths.fleetBoxes, body)),
  updateFleetBox: (id: string, body: UpdateFleetBoxBody) =>
    run(request(FleetBox, "PATCH", ControlPaths.fleetBox(id), body)),
  deleteFleetBox: async (id: string): Promise<void> => {
    await run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.fleetBox(id))))
  },
  rotateFleetBoxSecret: (id: string) => run(request(CreatedFleetBox, "POST", ControlPaths.fleetBoxSecret(id))),
  /** Operator-only: the most common failures of the server's default window, most common first. */
  fleetToolFailures: () => run(request(ToolFailureList, "GET", ControlPaths.fleetToolFailures)),
  checkBox,
  forgetBox,
  /** Status of the box the apps talk to: Kestrel's box (its managed box's own health, or the relayed status), or the active user box's own health. */
  boxStatus: async (): Promise<BoxStatus> => statusOf(await activeTarget()),
  /** Status of Kestrel's box, whichever box is active. */
  kestrelBoxStatus: (): Promise<BoxStatus> => statusOf(kestrelTarget()),

  // Agent box: box-level state comes from the active box; everything about a thread comes from the thread's own box.
  cliAuth: () => onActive(Schema.Array(CliAuthStatus), "GET", ControlPaths.cliAuthFor(CliProvider.literals)),
  providerUsage: () => onActive(Schema.Array(ProviderUsage), "GET", ControlPaths.cliUsageFor(CliProvider.literals)),
  /** What the active box can run, as it found at startup. */
  capabilities: () => onActive(BoxCapabilities, "GET", Paths.capabilities),
  /**
   * The active box's model catalog and the discovery sources behind it. `refresh` asks the box to bypass its cached
   * discovery; `boxId` pins the read to the box a mounted picker was opened for, so a box switch mid-read cannot mix
   * two catalogs.
   */
  models: (refresh = false, boxId?: string | null) => {
    const path = `${Paths.models}${refresh ? "?refresh=1" : ""}`
    return boxId === undefined
      ? onActive(ModelCatalog, "GET", path)
      : onBox(boxId, ModelCatalog, "GET", path)
  },
  /**
   * The signed-in user's generated-text preferences. `boxId` pins the read to the box a settings form was opened for;
   * omitted, it reads the active box.
   */
  textGenerationSettings: (boxId?: string | null) =>
    boxId === undefined
      ? onActive(TextGenerationSettings, "GET", Paths.textGenerationSettings)
      : onBox(boxId, TextGenerationSettings, "GET", Paths.textGenerationSettings),
  /** Replaces the signed-in user's generated-text preferences, on the same box `textGenerationSettings` read. */
  saveTextGenerationSettings: (settings: TextGenerationSettings, boxId?: string | null) =>
    boxId === undefined
      ? onActive(TextGenerationSettings, "PUT", Paths.textGenerationSettings, settings)
      : onBox(boxId, TextGenerationSettings, "PUT", Paths.textGenerationSettings, settings),
  /** The signed-in user's thread preferences, read from the active box or the one a settings form was pinned to. */
  threadSettings: (boxId?: string | null) =>
    boxId === undefined
      ? onActive(ThreadSettings, "GET", Paths.threadSettings)
      : onBox(boxId, ThreadSettings, "GET", Paths.threadSettings),
  /** Replaces the signed-in user's thread preferences, on the same box `threadSettings` read. */
  saveThreadSettings: (settings: ThreadSettings, boxId?: string | null) =>
    boxId === undefined
      ? onActive(ThreadSettings, "PUT", Paths.threadSettings, settings)
      : onBox(boxId, ThreadSettings, "PUT", Paths.threadSettings, settings),
  cliLoginStart: (provider: CliProvider) => onActive(CliLoginStart, "POST", ControlPaths.cliLogin(provider)),
  cliLoginCode: (provider: CliProvider, body: CliLoginCodeBody) =>
    onActive(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body),
  cliLoginKey: (provider: CliProvider, body: PutApiKeyBody) =>
    onActive(CliAuthStatus, "POST", ControlPaths.cliLoginKey(provider), body),
  cliLogout: async (provider: CliProvider): Promise<void> => {
    await onActive(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider))
  },
  useBankedReset: (provider: CliProvider, body: UseBankedResetBody) =>
    onActive(UseBankedResetResult, "POST", ControlPaths.cliUseBankedReset(provider), body),
  taskFileUrl,
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
  /** Counted in the browser's time zone, so the days match the user's calendar. */
  usageActivity: () =>
    onActive(
      UsageActivity,
      "GET",
      `${Paths.usageActivity}?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
    ),
  /** Every box's threads, merged; a box that does not answer is left out unless none does. */
  listTasks: listAllTasks,
  /** Creates a thread on `boxId` (`null`: Kestrel's box), or on the active box when omitted. */
  createTask: async (body: CreateTaskBody, boxId?: string | null): Promise<Task> => {
    const target = boxId === undefined ? await activeTarget() : routeOf(boxId)
    if (target === undefined) throw new ApiError(404, "That box is no longer in your box list")
    const task = await run(boxCall(target, Task, "POST", Paths.tasks, body))
    taskBoxes.set(task.id, target?.boxId ?? null)
    return task
  },
  getTask: (taskId: string) => onTask(taskId, Task, "GET", Paths.task(taskId)),
  /** The user box a thread lives on, or `null` for Kestrel's box (managed or relayed). */
  taskBox: async (taskId: string): Promise<string | null> => {
    const target = await taskTarget(taskId)
    return target === null || target.boxId === known?.managedBox?.id ? null : target.boxId
  },
  archiveTask: (taskId: string) => onTask(taskId, Task, "POST", Paths.taskArchive(taskId)),
  unarchiveTask: (taskId: string) => onTask(taskId, Task, "DELETE", Paths.taskArchive(taskId)),
  /** Deletes the thread for good: its history, checkouts and files. */
  deleteTask: async (taskId: string): Promise<void> => {
    await onTask(taskId, Schema.Unknown, "DELETE", Paths.task(taskId))
  },
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
  cancelDelegation: (taskId: string, childId: string) => onTask(taskId, Task, "POST", Paths.taskDelegationCancel(taskId, childId)),
  /** Turns a thread's armed usage-limit auto-resume on or off; the box answers with the thread as stored. */
  setUsageLimitAutoResume: (taskId: string, autoResume: boolean) =>
    onTask(taskId, Task, "PUT", Paths.taskUsageLimit(taskId), { autoResume }),
  getDiff: (taskId: string) => onTask(taskId, DiffResponse, "GET", Paths.taskDiff(taskId)),
  /** Every pull request the thread owns or manages, with GitHub's live view of each. */
  getThreadPullRequests: (taskId: string) =>
    onTask(taskId, ThreadPullRequests, "GET", Paths.taskPullRequests(taskId)),
  getThreadPullRequest: (taskId: string, repo: string, number: number) =>
    onTask(taskId, ThreadPullRequestDetail, "GET", Paths.taskPullRequest(taskId, repo, number)),
  getThreadPullRequestDiff: (taskId: string, repo: string, number: number) =>
    onTask(taskId, ThreadPullRequestDiff, "GET", Paths.taskPullRequestDiff(taskId, repo, number)),
  /** Comments, reviews, merges and the rest; the box answers with the thread as stored. */
  actOnThreadPullRequest: (taskId: string, action: ThreadPullRequestAction) =>
    onTask(taskId, Task, "POST", Paths.taskPullRequestAction(taskId), action),
  getFiles: (taskId: string, hidden: boolean) =>
    onTask(taskId, FilesResponse, "GET", Paths.taskFiles(taskId) + (hidden ? "?hidden=1" : "")),
  /**
   * Starts the browser's download of one of a thread's files. A HEAD request first finds out whether it would work:
   * handed straight to the browser, a failure would be saved as a file, or (cross-origin, on a user's own box) open as
   * a page in place of the app. Through Kestrel's relayed box a file over `MAX_RELAY_RESPONSE_BYTES` cannot be sent;
   * the relay answers that HEAD with 413 from the declared length alone.
   */
  downloadFile: async (taskId: string, root: FileRoot, path: string): Promise<void> => {
    const url = await taskFileUrl(taskId, Paths.taskFileDownload(taskId, root, path))
    const name = path.slice(path.lastIndexOf("/") + 1)
    const check = await fetch(url, { method: "HEAD" })
    if (check.status === 413) {
      throw new Error(
        `${name} is over ${MAX_RELAY_RESPONSE_BYTES / 1024 / 1024} MB, the most Kestrel's shared box can send. Use your own or a managed box for larger files.`,
      )
    }
    if (check.status === 404) throw new Error(`${name} is no longer there; refresh the list.`)
    if (!check.ok) throw new Error(`Could not download ${name} (HTTP ${check.status}).`)
    // The response is an attachment, so following the link saves the file and leaves the page as it is.
    const link = document.createElement("a")
    link.href = url
    link.download = ""
    link.click()
  },
  getDesktop: (taskId: string) => onTask(taskId, DesktopStatus, "GET", Paths.taskDesktop(taskId)),
  startDesktop: (taskId: string) => onTask(taskId, DesktopStatus, "POST", Paths.taskDesktop(taskId)),
  stopDesktop: async (taskId: string): Promise<void> => {
    await onTask(taskId, Schema.Unknown, "DELETE", Paths.taskDesktop(taskId))
  },
  setDesktopQuality: (taskId: string, body: SetDesktopQualityBody) =>
    onTask(taskId, DesktopStatus, "PUT", Paths.taskDesktopQuality(taskId), body),
}

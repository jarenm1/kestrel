import { availableHarnesses, availableModelHarnesses, boxCapabilities } from "./capabilities"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"
import { Effect, Fiber, Layer, Ref } from "effect"
import { BOX_USER_HEADER, CREDENTIALS_HEADER, InternalError, Paths } from "@cloudagents/protocol"
import { ConfigLive, Config, dataDirFromEnv } from "./config"
import { CliAuth, CliAuthLive } from "./cliauth"
import { CoreLive, CoreService } from "./core/service"
import { EventHubLive } from "./core/events"
import { AgentHarness, AgentHarnessLive } from "./core/harness"
import { StateLive } from "./core/state"
import { WorkspaceLive } from "./core/workspace"
import { CredentialBroker, CredentialBrokerLive } from "./broker"
import { BROKER_PREFIX, handleBroker } from "./broker/handler"
import { coreGhBackend } from "./gh/backend"
import { createGhHandler, GH_PREFIX } from "./gh/handler"
import { boxControl } from "./control/client"
import { CredentialStore, CredentialStoreLive } from "./credentials"
import { makeModelDiscovery } from "./model-discovery"
import { GitHubLive } from "./github/api"
import { DesktopManager, DesktopManagerLive, type DesktopRegion } from "./desktop"
import { createMcpHandler } from "./mcp"
import { TaskStatsLive } from "./stats"
import { makeWebHandler } from "./http/router"
import type { WsServices } from "./http/streams"
import { runRelay } from "./relay/client"
import { BOX_DEV_HEADER } from "./tunnel"
import { makeBoxAuth } from "./direct/auth"
import { makeBoxActivityReporter, type BoxActivityReporter } from "./direct/box-activity"
import { makeDirectListener, type DirectListener } from "./direct/listener"
import { openActivitySocket } from "./activity"
import { ensureNestSecret } from "./platform/enroll"
import { BoxPlatform, BoxPlatformLive } from "./platform"
import { ActivityTracker, ActivityTrackerLive } from "./platform/tracker"

const ServicesLive = Layer.mergeAll(
  ConfigLive,
  WorkspaceLive,
  EventHubLive,
  DesktopManagerLive,
  CredentialStoreLive,
  ActivityTrackerLive,
  Layer.provide(GitHubLive, ConfigLive),
)
// The broker checks a grant's liveness against the same StateStore core reads, so state is built before it.
const StateWithServices = Layer.provideMerge(StateLive, ServicesLive)
const BaseLive = Layer.provideMerge(CredentialBrokerLive, StateWithServices)
const CliAuthWithBase = Layer.provideMerge(CliAuthLive, BaseLive)
const HarnessWithBase = Layer.provideMerge(AgentHarnessLive, CliAuthWithBase)
const PlatformWithBase = Layer.provideMerge(BoxPlatformLive, HarnessWithBase)
const CoreWithBase = Layer.provideMerge(CoreLive, PlatformWithBase)
const AppLive = Layer.provideMerge(TaskStatsLive, CoreWithBase)

const MCP_PREFIX = "/mcp/"

/** Reads a node request body into a web Request so the Effect HttpApp can handle it. */
const toWebRequest = async (req: IncomingMessage): Promise<Request> => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    // Identity only comes through the relay; a local caller (e.g. a sandboxed agent) cannot claim a user or dev access.
    if (name === BOX_USER_HEADER || name === BOX_DEV_HEADER || name === CREDENTIALS_HEADER) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  const method = req.method ?? "GET"
  const chunks: Buffer[] = []
  if (method !== "GET" && method !== "HEAD") {
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  return new Request(url, { method, headers, body })
}

/** Writes a web Response back onto the node response, streaming its body. */
const writeWebResponse = async (res: ServerResponse, web: Response): Promise<void> => {
  res.statusCode = web.status
  web.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  if (web.body === null) {
    res.end()
    return
  }
  const reader = web.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

const failResponse = (res: ServerResponse, error: unknown) => {
  console.error("request failed:", error)
  if (!res.headersSent) {
    res.statusCode = 500
    res.setHeader("content-type", "application/json")
  }
  res.end(JSON.stringify({ _tag: "InternalError", message: "internal server error" }))
}

const listen = (server: Server, host: string, port: number) =>
  Effect.async<void, InternalError>((resume) => {
    const onError = (e: Error) => resume(Effect.fail(new InternalError({ message: `listen failed: ${e.message}` })))
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  })

const untilSignal = Effect.async<void>((resume) => {
  const onSignal = () => resume(Effect.void)
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
})

const closeServer = (server: Server) =>
  Effect.async<void>((resume) => {
    server.close(() => resume(Effect.void))
    server.closeAllConnections()
  })

const program = Effect.gen(function* () {
  const config = yield* Config
  const core = yield* CoreService
  const desktop = yield* DesktopManager
  const broker = yield* CredentialBroker
  const cliAuth = yield* CliAuth
  const harness = yield* AgentHarness
  const credentials = yield* CredentialStore
  const models = yield* makeModelDiscovery({ credentials, native: cliAuth, dataDir: config.dataDir })
  const platform = yield* BoxPlatform
  const tracker = yield* ActivityTracker
  // The box's startup snapshot: which harness CLIs it found.
  const capabilities = {
    ...boxCapabilities(config.sandbox, undefined, platform.hardware),
    harnesses: availableHarnesses(config),
    modelHarnesses: availableModelHarnesses(config),
  }
  // One client for the control plane: the automations' watch tools and the pull request view's watch action share it.
  const control = boxControl(config)
  const webHandler = yield* makeWebHandler(core, cliAuth, capabilities, models, {
    watchPullRequest: control === null ? null : (user, taskId, repo, number, watching) =>
      (watching ? control.watchPr(user, taskId, repo, number) : control.unwatchPr(user, taskId, repo, number)).pipe(
        Effect.mapError((e) => new InternalError({ message: e.message })),
      ),
  })
  // Any request or relayed message is activity: it keeps a Nest VM from suspending while someone uses it. The health
  // check is the exception: clients poll it in the background, so it would keep an idle box awake forever.
  const handle = (request: Request) => {
    if (new URL(request.url).pathname !== Paths.health) Effect.runSync(tracker.touch)
    return webHandler(request)
  }

  const mcpHandler = createMcpHandler({
    auth: { grantFor: broker.grantForToken, runFor: core.runFor, onRevoke: broker.onRevoke },
    models: { list: (user) => models.list(user) },
    desktop: {
      open: (taskId) => core.desktopOpen(taskId),
      status: (taskId) => desktop.status(taskId),
      screenshot: (taskId: string, crop?: DesktopRegion, scale?: number) => desktop.screenshot(taskId, crop, scale),
      grab: (taskId) => desktop.grab(taskId),
      cursor: (taskId) => desktop.cursor(taskId),
      input: (taskId, event) => desktop.input(taskId, event),
      launch: (taskId, command) => core.desktopLaunch(taskId, command),
      processes: (taskId) => desktop.processes(taskId),
      kill: (taskId, id) => desktop.kill(taskId, id),
    },
    evidence: {
      start: (taskId, runId, caption) => core.evidenceRecordStart(taskId, runId, caption),
      stop: (taskId, runId) => core.evidenceRecordStop(taskId, runId),
      attach: (taskId, input) => core.attachRunEvidenceToPullRequest(taskId, input),
    },
    workspace: {
      checkout: core.checkout,
      exec: (taskId, command, timeoutMs) => core.execInTask(taskId, command, timeoutMs),
    },
    toolkits: config.toolkitsFlake === null ? null : { install: core.toolkitInstall },
    report: core.report,
    github: {
      push: core.gitPush,
      openPullRequest: core.openPullRequest,
      pullRequestStatus: core.pullRequestStatus,
      readReference: core.readReference,
      reviewPullRequest: core.reviewPullRequest,
      updatePullRequest: core.updatePullRequest,
      commentOnPullRequest: core.commentOnPullRequest,
      changeReviewers: core.changeReviewers,
      changeLabels: core.changeLabels,
    },
    ask: core.ask,
    automations: {
      control,
      taskOwner: core.taskOwner,
      setWatching: core.setPullRequestWatching,
      forgetWatching: core.forgetPullRequestWatch,
      clearWatching: core.clearPullRequestWatching,
    },
    inbox: core.inbox,
    threads: { maxConcurrentRuns: config.maxConcurrentRuns, owner: core.taskOwner, create: core.createTask, archive: core.archiveTask, list: core.listTasks, messages: core.listMessages, send: core.sendToThread, delegate: core.delegate, delegatedStatus: core.delegatedStatus, cancelDelegation: core.cancelDelegation, acknowledgeDelegation: core.acknowledgeDelegation, withSlotReleased: harness.withSlotReleased },
    previewOpen: core.previewOpen,
    gpu: platform.gpuOnDemand,
  })

  const ghHandler = createGhHandler({
    grantFor: broker.grantForToken,
    runFor: core.runFor,
    backend: (taskId) => coreGhBackend(core, taskId),
  })

  let direct: DirectListener | null = null
  /** Reports this managed box's active users; null on a user's own box, which reports to no fleet. */
  let boxActivity: BoxActivityReporter | null = null
  if (config.direct !== null) {
    const store = yield* CredentialStore
    boxActivity = config.direct.managed ? makeBoxActivityReporter(config.direct) : null
    direct = makeDirectListener({
      auth: makeBoxAuth(config.direct, store, fetch, boxActivity ?? undefined),
      activity: boxActivity ?? undefined,
      core,
      webHandler: handle,
      runtime: yield* Effect.runtime<WsServices>(),
    })
  }
  const serve = direct === null ? handle : direct.handle

  const server = createServer((req, res) => {
    toWebRequest(req).then(serve).then((response) => writeWebResponse(res, response))
      .catch((error: unknown) => failResponse(res, error))
  })
  const sandboxServer = createServer((req, res) => {
    const handled = req.url?.startsWith(BROKER_PREFIX)
      ? handleBroker(broker, req, res)
      : req.url?.startsWith(MCP_PREFIX)
        ? mcpHandler(req, res)
        : req.url?.startsWith(GH_PREFIX)
          ? ghHandler(req, res)
          : Promise.resolve().then(() => { res.statusCode = 404; res.end() })
    handled.catch((error: unknown) => failResponse(res, error))
  })

  // Relayed task streams arrive through the control plane; direct mode serves them on this listener.
  if (direct !== null) server.on("upgrade", direct.upgrade)

  yield* listen(sandboxServer, "127.0.0.1", config.sandboxPort)
  yield* listen(server, config.host, config.port)
  yield* Effect.logInfo(`cloudagents server listening on http://${config.host}:${config.port}`)
  yield* Effect.logInfo(`sandbox listener on 127.0.0.1:${config.sandboxPort}`)

  // Reports start only once the box actually serves; a managed box sends an empty snapshot first, then every 30 seconds.
  boxActivity?.start()

  // box-auto asks this socket whether a restart would interrupt running work (see docs/box.md).
  const activity = yield* openActivitySocket(
    join(config.dataDir, "box.sock"),
    Effect.all({ runs: harness.activeRunCount(), desktops: desktop.activeCount() }),
  )

  // The control plane link. A Nest VM's resume restarts it, since its socket from before the snapshot is dead.
  const relayFiber = yield* Ref.make<Fiber.RuntimeFiber<void> | null>(null)
  const startRelay = Effect.gen(function* () {
    if (config.relay === null) return
    const fiber = yield* Effect.forkDaemon(
      runRelay({ controlUrl: config.relay.controlUrl, boxToken: config.relay.boxToken, handle }),
    )
    yield* Ref.set(relayFiber, fiber)
    yield* Effect.logInfo(`box connecting to control plane at ${config.relay.controlUrl}`)
  })
  yield* startRelay

  // The resume hook restarts the relay, which needs the services the relay runs with; the platform needs none.
  const relayServices = yield* Effect.context<WsServices | CredentialStore>()
  const platformFiber = yield* Effect.forkDaemon(
    platform.run({
      resumed: Effect.gen(function* () {
        const old = yield* Ref.get(relayFiber)
        if (old !== null) yield* Fiber.interrupt(old)
        yield* startRelay
      }).pipe(Effect.provide(relayServices)),
    }),
  )

  yield* untilSignal
  yield* Effect.logInfo("shutting down")
  boxActivity?.stop()
  if (activity !== null) yield* activity.close
  yield* Fiber.interrupt(platformFiber)
  const relay = yield* Ref.get(relayFiber)
  if (relay !== null) yield* Fiber.interrupt(relay)
  yield* cliAuth.shutdown()
  yield* core.shutdown()
  if (direct !== null) direct.close()
  yield* closeServer(server)
  yield* closeServer(sandboxServer)
}).pipe(Effect.provide(AppLive))

// A Nest VM enrolls before the config loads: the secret it stores is what the config reads.
Effect.runPromise(ensureNestSecret(process.env, dataDirFromEnv()).pipe(Effect.andThen(program))).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("cloudagents server failed:", error)
    process.exit(1)
  },
)

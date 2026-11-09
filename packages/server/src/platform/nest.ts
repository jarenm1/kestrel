import { readdir, readlink } from "node:fs/promises"
import { Effect, Layer } from "effect"
import type { BoxActivity } from "@cloudagents/protocol"
import { VERSION } from "../config"
import { StateStore } from "../core/state"
import { EventHub } from "../core/events"
import { AgentHarness } from "../core/harness"
import { DesktopManager } from "../desktop"
import { startGuestLink, type GuestLink } from "./guest-link"
import { GpuWishes, withdrawWishesOnRunEnd } from "./gpu-wish"
import { GpuReconciler } from "./gpu-state"
import { ActivityTracker } from "./tracker"
import { BoxPlatform, PlatformError, type PlatformHardware, type PlatformHooks } from "./service"
import { readStoredSecret } from "./secret"

/** A Nest VM: the host lends it a GPU on demand and suspends it when idle (see the GPU and suspend rules in docs/nest.md). */
export const NEST_HARDWARE: PlatformHardware = { gpu: "on-demand", suspend: true }

/** How long a request waits for the host to attach the GPU. */
const GPU_ATTACH_TIMEOUT_MS = 120_000
/** How long a release waits for processes to let go of the GPU device nodes. */
const GPU_RELEASE_TIMEOUT_MS = 10_000
const GPU_POLL_MS = 250

/** Processes holding a GPU device node open (a DRI or NVIDIA device). Processes we cannot inspect are not counted. */
const gpuUsers = Effect.promise(async () => {
  const pids = await readdir("/proc").catch(() => [] as string[])
  let users = 0
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => null)
    if (fds === null) continue
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")
      if (target.startsWith("/dev/dri/") || target.startsWith("/dev/nvidia")) {
        users++
        break
      }
    }
  }
  return users
})

/** Waits until no process holds the GPU, or fails after `GPU_RELEASE_TIMEOUT_MS`. */
const waitForGpuRelease = Effect.gen(function* () {
  const deadline = Date.now() + GPU_RELEASE_TIMEOUT_MS
  while ((yield* gpuUsers) > 0) {
    if (Date.now() >= deadline) {
      return yield* Effect.fail(new PlatformError({ message: "the GPU is still in use after 10 s" }))
    }
    yield* Effect.sleep(GPU_POLL_MS)
  }
})

/**
 * The box's link to its Nest guest agent. The desktop renders on the GPU only while the guest reports it attached;
 * `request` asks the host for it, and `releaseGpu` stops the desktop's use before the host unplugs it.
 */
export const NestPlatformLive = (socketPath: string, dataDir: string) =>
  Layer.effect(
    BoxPlatform,
    Effect.gen(function* () {
      const desktop = yield* DesktopManager
      const store = yield* StateStore
      const tracker = yield* ActivityTracker
      const harness = yield* AgentHarness
      const hub = yield* EventHub
      // A stored secret means the box enrolled; the guest is told so it drops the enrollment token from its env file.
      const enrolled = readStoredSecret(dataDir) !== null

      let link: GuestLink | null = null
      const wishes = new GpuWishes()
      // A run that ends without releasing the GPU (succeeded, failed or cancelled) withdraws its own wish.
      withdrawWishesOnRunEnd(hub.subscribeAll, wishes, (wanted) => link?.setWanted(wanted))

      const activity = (): BoxActivity => {
        const snapshot = Effect.runSync(tracker.snapshot)
        return {
          runs: Effect.runSync(harness.activeRunCount()),
          desktops: Effect.runSync(desktop.activeCount()),
          viewers: snapshot.viewers,
          recordings: 0,
          lastActivityAt: snapshot.lastActivityAt,
        }
      }

      // Level-triggered truth: store every host report, reconcile renderers from it, and replay it on reconnect.
      const gpu = new GpuReconciler({
        attachHardware: desktop.attachHardwareRender,
        releaseHardware: desktop.releaseHardwareRender,
        warn: (message) => Effect.runSync(Effect.logWarning(message)),
        onSnapshot: (snapshot) => {
          if (snapshot.attaching) {
            Effect.runSync(Effect.logInfo(`guest GPU attaching since ${snapshot.attachingSince}; desktops wait on software`))
          }
        },
      })

      const releaseGpu = Effect.gen(function* () {
        yield* desktop.releaseHardwareRender
        yield* waitForGpuRelease
      })

      const drop = (runId: string) => Effect.sync(() => link?.setWanted(wishes.remove(runId)))

      const request = (runId: string) =>
        Effect.gen(function* () {
          if (link === null) {
            return yield* Effect.fail(new PlatformError({ message: "the box is not connected to its guest agent" }))
          }
          // The guest answers the wish once the GPU is attached; a denial fails the request at once.
          const answer = link.setWanted(wishes.add(runId))
          yield* Effect.tryPromise({
            try: () => answer,
            catch: (error) =>
              new PlatformError({
                message: `the GPU was not granted: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }).pipe(
            Effect.timeoutFail({
              duration: GPU_ATTACH_TIMEOUT_MS,
              onTimeout: () => new PlatformError({ message: "the GPU did not attach within 120 s" }),
            }),
          )
        }).pipe(Effect.onError(() => drop(runId)))

      return BoxPlatform.of({
        hardware: NEST_HARDWARE,
        gpuOnDemand: {
          request,
          release: drop,
          state: Effect.sync(() => gpu.snapshot()),
        },
        run: (hooks: PlatformHooks) =>
          Effect.async<void>(() => {
            const current = startGuestLink({
              socketPath,
              boxVersion: VERSION,
              activity,
              warn: (message) => Effect.runSync(Effect.logWarning(message)),
              handlers: {
                quiesce: () => Effect.runPromise(store.flush),
                resumed: async () => {
                  link?.sendActivityNow()
                  await Effect.runPromise(hooks.resumed)
                },
                releaseGpu: () => Effect.runPromise(releaseGpu),
                gpuState: (state) => Effect.runPromise(gpu.observe(state)),
              },
              onConnect: () => Effect.runFork(gpu.replay()),
            })
            link = current
            if (enrolled) current.markEnrolled()
            if (wishes.wanted()) current.setWanted(true)
            return Effect.sync(() => {
              current.close()
              gpu.close()
              link = null
            })
          }),
      })
    }),
  )

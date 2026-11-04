import { readdir, readlink } from "node:fs/promises"
import { Effect, Layer, Ref } from "effect"
import type { BoxActivity, GpuState } from "@cloudagents/protocol"
import { VERSION } from "../config"
import { StateStore } from "../core/state"
import { AgentHarness } from "../core/harness"
import { DesktopManager } from "../desktop"
import { startGuestLink, type GuestLink } from "./guest-link"
import { ActivityTracker } from "./tracker"
import { BoxPlatform, PlatformError, type PlatformHardware, type PlatformHooks } from "./service"

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
export const NestPlatformLive = (socketPath: string) =>
  Layer.effect(
    BoxPlatform,
    Effect.gen(function* () {
      const desktop = yield* DesktopManager
      const store = yield* StateStore
      const tracker = yield* ActivityTracker
      const harness = yield* AgentHarness

      let link: GuestLink | null = null
      const gpuState = yield* Ref.make<GpuState>("none")

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

      const gpuChanged = (state: GpuState) =>
        Effect.gen(function* () {
          yield* Ref.set(gpuState, state)
          if (state === "attached") yield* desktop.setHardwareRender(true)
          else if (state === "none" || state === "detaching") yield* desktop.setHardwareRender(false)
        })

      const releaseGpu = Effect.gen(function* () {
        yield* desktop.setHardwareRender(false)
        yield* waitForGpuRelease
      })

      const request = Effect.gen(function* () {
        if (link === null) {
          return yield* Effect.fail(new PlatformError({ message: "the box is not connected to its guest agent" }))
        }
        if ((yield* Ref.get(gpuState)) === "attached") return
        link.setWanted(true)
        const deadline = Date.now() + GPU_ATTACH_TIMEOUT_MS
        while ((yield* Ref.get(gpuState)) !== "attached") {
          if (Date.now() >= deadline) {
            link.setWanted(false)
            return yield* Effect.fail(new PlatformError({ message: "the GPU did not attach within 120 s" }))
          }
          yield* Effect.sleep(GPU_POLL_MS)
        }
      })

      return BoxPlatform.of({
        hardware: NEST_HARDWARE,
        gpuOnDemand: {
          request,
          release: Effect.sync(() => link?.setWanted(false)),
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
                gpuState: (state) => Effect.runPromise(gpuChanged(state)),
              },
            })
            link = current
            return Effect.sync(() => {
              current.close()
              link = null
            })
          }),
      })
    }),
  )

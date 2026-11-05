import { Effect, Layer } from "effect"
import { Config } from "../config"
import { NestPlatformLive } from "./nest"
import { BoxPlatform } from "./service"

export { BoxPlatform, PlatformError, type BoxPlatformShape, type GpuOnDemand, type PlatformHardware } from "./service"

const LocalPlatformLive = Layer.succeed(BoxPlatform, {
  hardware: null,
  gpuOnDemand: null,
  run: () => Effect.void,
})

/** The Nest platform when the box runs in a Nest VM (its guest agent socket is configured), else the plain local one. */
export const BoxPlatformLive = Layer.unwrapEffect(
  Effect.map(Config, (config) =>
    config.nest === null ? LocalPlatformLive : NestPlatformLive(config.nest.guestSocket, config.dataDir),
  ),
)

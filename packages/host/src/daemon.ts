import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, readHostSecret } from "./config"
import { ControlLink } from "./control-link"
import { acquireVmLock } from "./lock"
import { type LocalApi, startLocalApi } from "./local-api"
import { shipMeterRecords } from "./outbox"
import { stateLayout } from "./state-store"
import { readGuestImage } from "./template"
import { errorMessage } from "./errors"
import { VmManager } from "./vm-manager"

/** The group kestrel-ingress runs as; it may reach `api.sock` and nothing else. */
const INGRESS_GROUP = "kestrel-ingress"

/** How often queued meter records are posted to the control plane. */
const METER_SHIP_INTERVAL_MS = 60_000

const log = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} kestrel-host: ${message}\n`)
}

/**
 * Runs the host agent until SIGTERM or SIGINT. Startup re-adopts the VMs left by a previous run; shutdown leaves the
 * VMs running, so a restart of the agent does not stop anyone's box.
 */
export const runDaemon = async (configPath: string): Promise<void> => {
  const config = loadConfig(configPath)
  const secret = readHostSecret(config.hostSecretFile)
  const layout = stateLayout(config.stateDir)
  mkdirSync(layout.root, { recursive: true, mode: 0o700 })
  const lock = acquireVmLock(layout.root)
  const image = readGuestImage(config.guestImageDir)

  // The manager reports through the link and the link drives the manager. Events raised during start() are dropped;
  // the hello that follows carries the state.
  let control: ControlLink | null = null
  const manager = new VmManager(config, layout, {
    vm: (report) => control?.sendVm(report),
    wakeRequest: (boxId) => control?.sendWakeRequest(boxId),
    error: log,
    notice: log,
  })
  let link: ControlLink
  let api: LocalApi
  try {
    await manager.start()
    link = new ControlLink({
      controlUrl: config.controlUrl,
      hostId: config.hostId,
      secret,
      slug: config.slug,
      agentVersion: config.agentVersion,
      imageId: image.imageId,
      manager,
      log,
    })
    control = link
    api = startLocalApi({ runDir: config.runDir, ingressGroup: INGRESS_GROUP, manager })
    link.start()
  } catch (error) {
    manager.stop()
    lock.release()
    log(`startup failed, the host agent is not running: ${errorMessage(error)}`)
    process.exit(1)
  }

  // A shipment that outlives the interval is not joined by a second one: two shipments could post the same records.
  let shipping = false
  const shipTimer = setInterval(() => {
    if (shipping) return
    shipping = true
    shipMeterRecords({ outbox: manager.outbox, meterUrl: config.meterUrl, hostId: config.hostId, secret })
      .catch((error: unknown) => log(`meter shipping failed: ${errorMessage(error)}`))
      .finally(() => {
        shipping = false
      })
  }, METER_SHIP_INTERVAL_MS)

  const shutdown = (): void => {
    clearInterval(shipTimer)
    link.stop()
    api.stop()
    manager.stop()
    lock.release()
    process.exit(0)
  }
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)
  log(`host ${config.hostId} running; ${manager.reports().length} VMs adopted`)
}

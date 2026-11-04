import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { ChClient, templateVmConfig } from "./ch-api"
import type { HostConfig } from "./config"
import { HostError, errorMessage } from "./errors"
import { fsyncDir, fsyncPath } from "./fs-atomic"
import { launchVmm, stopVmm, waitForApi, type ScopeMode } from "./ch-process"
import { GUEST_MAC } from "./network"
import type { ProcIdentity } from "./proc"
import { STRICT } from "./schema"
import type { StateLayout } from "./state-store"
import { runChecked, runTool } from "./tools"
import { connectGuest } from "./vsock"

/**
 * A template is a snapshot of a booted, unconfigured guest for one guest image. Every VM is cloned from it: the clone
 * restores the template's memory and devices with its own tap, cid and sockets, then gets its identity via `configure`.
 * A template holds no secret and no identity.
 */

/** `manifest.json` written by the guest image build. Relative paths are resolved against the image directory. */
const GuestManifest = Schema.Struct({
  imageId: Schema.String,
  kernel: Schema.String,
  initrd: Schema.NullOr(Schema.String),
  store: Schema.String,
  cmdline: Schema.String,
})

export interface GuestImage {
  readonly imageId: string
  readonly kernel: string
  readonly initrd: string | null
  readonly store: string
  /** The kernel command line text. */
  readonly cmdline: string
}

/** Reads the guest image in `dir`: manifest plus the command line file it names. Throws HostError when invalid. */
export const readGuestImage = (dir: string): GuestImage => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  } catch (error) {
    throw new HostError(`cannot read guest image manifest in ${dir}: ${errorMessage(error)}`)
  }
  const decoded = Schema.decodeUnknownEither(GuestManifest)(json, STRICT)
  if (decoded._tag === "Left") throw new HostError(`invalid guest image manifest in ${dir}: ${String(decoded.left)}`)
  const manifest = decoded.right
  return {
    imageId: manifest.imageId,
    kernel: resolve(dir, manifest.kernel),
    initrd: manifest.initrd === null ? null : resolve(dir, manifest.initrd),
    store: resolve(dir, manifest.store),
    cmdline: readFileSync(resolve(dir, manifest.cmdline), "utf8").trim(),
  }
}

/** Tap for the template's own NIC; it exists only while the template boots. */
export const templateTap = (imageId: string): string =>
  `kt-${createHash("sha256").update(imageId).digest("hex").slice(0, 8)}`

/** Cid the template boots with. Clones rewrite it to their own cid on restore. */
const TEMPLATE_CID = 3

export const templateDir = (layout: StateLayout, imageId: string): string => join(layout.templatesDir, imageId)

export const hasTemplate = (dir: string): boolean =>
  existsSync(join(dir, "config.json")) && existsSync(join(dir, "state.json")) && existsSync(join(dir, "memory-ranges"))

/**
 * Boots the image once with no volume, waits for the guest agent's hello, pauses and snapshots it. The snapshot is
 * written to `<dir>.tmp`, fsynced, and renamed to `<dir>`, so a template directory is either complete or absent.
 * Returns the template directory; a no-op when it already exists.
 */
export const buildTemplate = async (opts: {
  readonly config: HostConfig
  readonly layout: StateLayout
  readonly image: GuestImage
  readonly scope: ScopeMode
  readonly helloTimeoutMs: number
}): Promise<string> => {
  const { config, layout, image } = opts
  const final = templateDir(layout, image.imageId)
  if (hasTemplate(final)) return final
  const work = `${final}.tmp`
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true, mode: 0o700 })
  const tap = templateTap(image.imageId)
  const apiSocket = join(work, "api.sock")
  const vsockSocket = join(work, "vsock.sock")
  const consoleFile = join(work, "console.log")
  let identity: ProcIdentity | null = null
  try {
    await runTool("ip", ["link", "del", "dev", tap])
    await runChecked("ip", ["tuntap", "add", "dev", tap, "mode", "tap"])
    await runChecked("ip", ["link", "set", "dev", tap, "up"])
    identity = launchVmm({
      scope: opts.scope,
      unit: `kestrel-template-${image.imageId}`,
      chPath: config.cloudHypervisor,
      apiSocket,
      memoryMaxBytes: config.template.maxMemoryBytes + 256 * 1024 * 1024,
      logPath: consoleFile,
    })
    await waitForApi(apiSocket, identity, 10_000)
    const client = new ChClient(apiSocket)
    await client.create(
      templateVmConfig({
        kernel: image.kernel,
        initramfs: image.initrd,
        cmdline: image.cmdline,
        store: image.store,
        maxVcpus: config.template.maxVcpus,
        maxMemoryBytes: config.template.maxMemoryBytes,
        tap,
        mac: GUEST_MAC,
        cid: TEMPLATE_CID,
        vsockSocket,
        consoleFile,
      }),
    )
    await client.boot()
    const { link } = await connectGuest(vsockSocket, opts.helloTimeoutMs)
    link.close()
    await client.pause()
    await client.snapshot(work)
    await stopVmm(identity, apiSocket, 5_000)
    identity = null
    for (const name of ["memory-ranges", "state.json", "config.json"]) fsyncPath(join(work, name))
    for (const name of ["api.sock", "vsock.sock", "console.log"]) rmSync(join(work, name), { force: true })
    fsyncDir(work)
    renameSync(work, final)
    fsyncDir(layout.templatesDir)
    return final
  } catch (error) {
    await stopVmm(identity, apiSocket, 1_000)
    rmSync(work, { recursive: true, force: true })
    throw error
  } finally {
    await runTool("ip", ["link", "del", "dev", tap])
  }
}

/**
 * Deletes template directories that no current or running VM needs. `keep` is the image ids in use (the current
 * image plus those of running VMs, whose restores may still read a template).
 */
export const removeStaleTemplates = (layout: StateLayout, keep: ReadonlySet<string>): string[] => {
  const removed: string[] = []
  for (const name of readdirSync(layout.templatesDir)) {
    const imageId = name.endsWith(".tmp") ? name.slice(0, -4) : name
    if (keep.has(imageId)) continue
    rmSync(join(layout.templatesDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

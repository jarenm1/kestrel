import { readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HostError } from "./errors"
import { runChecked } from "./tools"

/**
 * A restore takes no path overrides, and the vsock device refuses to bind a socket path that already exists. So each
 * restore reads from its own directory: `memory-ranges` and `state.json` are reflinked from the source, and
 * `config.json` is rewritten with this VM's tap, vsock cid and socket, console file, and disk paths.
 */

/** The parts of Cloud Hypervisor's snapshot `config.json` the host rewrites. Other fields pass through unchanged. */
export interface SnapshotConfig {
  readonly net: readonly { readonly tap?: string }[]
  readonly vsock: { readonly cid: number; readonly socket: string }
  readonly console: { readonly mode: string; readonly file?: string }
  /** Absent or null when the snapshot has no disks. */
  readonly disks?: readonly { readonly id?: string; readonly path?: string }[] | null
}

export interface RestoreTarget {
  readonly tap: string
  readonly cid: number
  readonly vsockSocket: string
  readonly consoleFile: string
  /** The volume's path now: the lazy device while it is served, otherwise the local `volume.raw`. */
  readonly volumePath: string
  readonly swapPath: string
}

/** Points a snapshot config at this VM's tap, cid, vsock socket, console file and disks. Pure: returns a new object. */
export const rewriteRestoreConfig = <C extends SnapshotConfig>(config: C, target: RestoreTarget): C => {
  if (config.net.length !== 1) throw new HostError(`snapshot must have exactly one NIC, found ${config.net.length}`)
  const disks =
    config.disks === undefined || config.disks === null
      ? config.disks
      : config.disks.map((disk) => {
          if (disk.id === "volume") return { ...disk, path: target.volumePath }
          if (disk.id === "swap") return { ...disk, path: target.swapPath }
          return disk
        })
  return {
    ...config,
    net: [{ ...config.net[0], tap: target.tap }],
    vsock: { ...config.vsock, cid: target.cid, socket: target.vsockSocket },
    console: { ...config.console, mode: "File", file: target.consoleFile },
    disks,
  }
}

export const SNAPSHOT_FILES = ["memory-ranges", "state.json"] as const

/** Fills `restoreDir` from a snapshot directory so that restoring it binds this VM's devices. */
export const prepareRestoreDir = async (opts: {
  readonly sourceDir: string
  readonly restoreDir: string
  readonly target: RestoreTarget
}): Promise<void> => {
  rmSync(opts.restoreDir, { recursive: true, force: true })
  mkdirSync(opts.restoreDir, { recursive: true, mode: 0o700 })
  for (const name of SNAPSHOT_FILES) {
    await runChecked("cp", ["--reflink=auto", join(opts.sourceDir, name), join(opts.restoreDir, name)])
  }
  const config = JSON.parse(readFileSync(join(opts.sourceDir, "config.json"), "utf8")) as SnapshotConfig
  writeFileSync(join(opts.restoreDir, "config.json"), `${JSON.stringify(rewriteRestoreConfig(config, opts.target))}\n`, {
    mode: 0o600,
  })
}

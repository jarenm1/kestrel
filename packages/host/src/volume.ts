import { Schema } from "effect"
import { HostError } from "./errors"
import { isProcessAlive, readProcStat, sleep, type ProcIdentity } from "./proc"
import { runChecked } from "./tools"
import type { ProcessRef } from "./schema"
import { openSync, closeSync } from "node:fs"

/**
 * Wrapper over the `kestrel-volume` tool: it owns a box's data volume in the backing store (a `file://` directory or
 * `s3://` bucket), backs it up as content-addressed chunks, and serves a lazily restored volume as a block device.
 */

export interface VolumeTool {
  readonly tool: string
  readonly store: string
  readonly keyFile: string | null
}

const VolumeBackupResult = Schema.Struct({
  volumeRef: Schema.String,
  bytesUploaded: Schema.Number,
  chunks: Schema.Number,
})
export type VolumeBackupResult = typeof VolumeBackupResult.Type

const LazyDevice = Schema.Struct({ device: Schema.String })

export const createVolume = async (volume: VolumeTool, path: string, sizeBytes: number): Promise<void> => {
  await runChecked(volume.tool, ["create", "--path", path, "--size-bytes", String(sizeBytes)])
}

export const backupVolume = async (
  volume: VolumeTool,
  opts: { readonly path: string; readonly boxId: string },
): Promise<VolumeBackupResult> => {
  const stdout = await runChecked(volume.tool, [
    "backup",
    "--path",
    opts.path,
    "--box",
    opts.boxId,
    "--store",
    volume.store,
    ...keyArgs(volume),
  ])
  return decodeOrThrow(VolumeBackupResult, stdout, "backup")
}

export const deleteVolumeStore = async (volume: VolumeTool, boxId: string): Promise<void> => {
  await runChecked(volume.tool, ["delete", "--box", boxId, "--store", volume.store])
}

export interface LazyVolume {
  readonly process: ProcessRef
  /** The block device that serves the restored volume. */
  readonly device: string
}

/**
 * Starts `kestrel-volume restore-lazy`, which prints `{"device": ...}` on its first stdout line and then keeps
 * serving the volume until it is terminated. Resolves once the device line arrives.
 */
export const startLazyVolume = async (
  volume: VolumeTool,
  opts: { readonly ref: string; readonly boxId: string; readonly dest: string; readonly logPath: string },
  timeoutMs: number,
): Promise<LazyVolume> => {
  const log = openSync(opts.logPath, "a", 0o600)
  const child = Bun.spawn(
    [
      volume.tool,
      "restore-lazy",
      "--ref",
      opts.ref,
      "--box",
      opts.boxId,
      "--store",
      volume.store,
      "--dest",
      opts.dest,
      ...keyArgs(volume),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: log },
  )
  closeSync(log)
  child.unref()
  const stat = readProcStat(child.pid)
  if (stat === null) throw new HostError("kestrel-volume exited before its identity was read")
  const process: ProcessRef = { pid: child.pid, startTime: stat.startTime, name: `kestrel-volume-${opts.boxId}` }
  try {
    const line = await firstLine(child.stdout, timeoutMs)
    const { device } = decodeOrThrow(LazyDevice, line, "restore-lazy")
    return { process, device }
  } catch (error) {
    await terminateProcess(process, 5_000)
    throw error
  }
}

/** Sends SIGTERM and waits; SIGKILL when the process ignores it. A no-op for a process that is gone. */
export const terminateProcess = async (identity: ProcIdentity | null, graceMs: number): Promise<void> => {
  if (identity === null || !isProcessAlive(identity)) return
  process.kill(identity.pid, "SIGTERM")
  const deadline = Date.now() + graceMs
  while (isProcessAlive(identity)) {
    if (Date.now() >= deadline) {
      process.kill(identity.pid, "SIGKILL")
      return
    }
    await sleep(50)
  }
}

const keyArgs = (volume: VolumeTool): string[] => (volume.keyFile === null ? [] : ["--key-file", volume.keyFile])

const decodeOrThrow = <A, I>(schema: Schema.Schema<A, I>, text: string, command: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(text))
  } catch {
    throw new HostError(`kestrel-volume ${command} printed unexpected output`)
  }
}

const firstLine = async (stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  while (!text.includes("\n")) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new HostError("kestrel-volume restore-lazy did not print its device in time")
    const next = await Promise.race([reader.read(), sleep(remaining).then(() => null)])
    if (next === null) throw new HostError("kestrel-volume restore-lazy did not print its device in time")
    if (next.done) throw new HostError("kestrel-volume restore-lazy exited before printing its device")
    text += decoder.decode(next.value)
  }
  reader.releaseLock()
  return text.slice(0, text.indexOf("\n"))
}

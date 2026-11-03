import { closeSync, ftruncateSync, fsyncSync, openSync, statSync, existsSync } from "node:fs"
import { HostError } from "./errors"
import { runTool, requireTool } from "./tools"
import type { VolumeIdentity } from "./schema"

export const DATA_VOLUME_LABEL = "kestrel-data"

const GIB = 1024 * 1024 * 1024

/** Parses `blkid -o export` output (KEY=VALUE lines) into a map. */
export const parseBlkidExport = (text: string): Map<string, string> => {
  const fields = new Map<string, string>()
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return fields
}

/**
 * Checks that the data disk carries the filesystem recorded for this VM. Uses `blkid -p` (low-level probe,
 * read-only). Never formats anything. Refuses when no filesystem is found or UUID/LABEL differ.
 */
export const verifyVolumeIdentity = (dataDisk: string, expected: VolumeIdentity): void => {
  const result = runTool("blkid", ["-p", "-o", "export", dataDisk])
  if (result.status !== 0) {
    throw new HostError(`blkid found no filesystem on ${dataDisk} (exit ${result.status}); refusing to start`)
  }
  const fields = parseBlkidExport(result.stdout)
  const uuid = fields.get("UUID")?.toLowerCase()
  const label = fields.get("LABEL")
  if (uuid !== expected.uuid.toLowerCase() || label !== expected.label) {
    throw new HostError(
      `data volume identity mismatch on ${dataDisk}: found uuid=${uuid ?? "none"} label=${label ?? "none"}, ` +
        `expected uuid=${expected.uuid} label=${expected.label}; refusing to start`,
    )
  }
}

/** Copies the base OS image with reflinks when the filesystem supports them. Refuses to overwrite. */
export const copyOsImage = (source: string, dest: string): void => {
  if (existsSync(dest)) throw new HostError(`refusing to overwrite ${dest}`)
  const result = runTool("cp", ["--reflink=auto", "--", source, dest])
  if (result.status !== 0) throw new HostError(`cp failed: ${result.stderr.trim()}`)
}

/**
 * Creates a sparse data disk of `gb` GiB and formats it ext4 with the fixed label and the given UUID.
 * The file is created exclusively (never overwritten). Size is set with ftruncate(2) rather than the
 * `truncate` binary so the refuse-if-exists check and error reporting stay in one place.
 */
export const createDataVolume = (dataDisk: string, gb: number, volume: VolumeIdentity): void => {
  requireTool("mkfs.ext4")
  const fd = openSync(dataDisk, "wx", 0o600)
  try {
    ftruncateSync(fd, gb * GIB)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const result = runTool("mkfs.ext4", ["-q", "-F", "-L", volume.label, "-U", volume.uuid, dataDisk])
  if (result.status !== 0) throw new HostError(`mkfs.ext4 failed: ${result.stderr.trim()}`)
  if (!statSync(dataDisk).isFile()) throw new HostError(`${dataDisk} is not a regular file`)
}

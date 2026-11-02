import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { initHost, vmPaths, writeVm } from "./state-store"
import type { VmRecord } from "./schema"
import type { HostContext } from "./vm-state"
import { DATA_VOLUME_LABEL } from "./disk"
import { isProcessAlive } from "./proc"

export const FAKE_QEMU = resolve(import.meta.dir, "test-fake-qemu.ts")

/** Temp directory removed by `dispose`. */
export interface TempDir {
  readonly path: string
  readonly dispose: () => void
}

export const makeTempDir = (label: string): TempDir => {
  const path = mkdtempSync(join(tmpdir(), `kestrel-host-${label}-`))
  return { path, dispose: () => rmSync(path, { recursive: true, force: true }) }
}

/** A launcher shell script that starts the fake QEMU with the names the host passes in the environment. */
export const writeFakeLauncher = (dir: string): string => {
  const path = join(dir, "fake-launcher.sh")
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_QEMU}" "$KESTREL_VM_NAME" "$KESTREL_VM_QMP_SOCKET"\n`)
  chmodSync(path, 0o755)
  return path
}

/** Context for tests: fake launcher, short readiness timeout, warnings captured into `warnings`. */
export const makeContext = (
  stateDir: string,
  launcher: string,
  env: NodeJS.ProcessEnv,
  warnings: string[] = [],
): HostContext => ({
  stateDir,
  launcher,
  accel: "tcg",
  readyTimeoutMs: 15_000,
  env,
  warn: (message) => warnings.push(message),
})

/** Writes a stopped VM record and its directory. Disk files are created as zero-filled placeholders. */
export const writeStoppedVm = (stateDir: string, overrides: Partial<VmRecord> = {}): VmRecord => {
  const hostId = initHost(stateDir).hostId
  const vmId = overrides.vmId ?? randomUUID()
  const paths = vmPaths(stateDir, vmId)
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  writeFileSync(paths.osDisk, Buffer.alloc(4096))
  writeFileSync(paths.dataDisk, Buffer.alloc(1 << 20))
  const now = new Date().toISOString()
  const record: VmRecord = {
    schemaVersion: 1,
    vmId,
    userId: "alice",
    hostId,
    shape: { cpus: 2, memoryMb: 2048 },
    state: "stopped",
    sequence: 0,
    osDisk: paths.osDisk,
    dataDisk: paths.dataDisk,
    volume: { label: DATA_VOLUME_LABEL, uuid: randomUUID() },
    process: null,
    createdAt: now,
    updatedAt: now,
    runningReported: false,
    lastError: null,
    ...overrides,
  }
  writeVm(stateDir, record)
  return record
}

/** Kills a recorded process if it is still alive. Used in test cleanup. */
export const killIfAlive = (vm: VmRecord | null): void => {
  if (vm?.process === null || vm?.process === undefined) return
  if (!isProcessAlive(vm.process)) return
  process.kill(vm.process.pid, "SIGKILL")
}

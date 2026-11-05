import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TEMPLATE_BOOT_MEMORY_BYTES } from "./ch-api"
import { loadConfig } from "./config"

const dir = mkdtempSync(join(tmpdir(), "nest-config-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const GIB = 1024 * 1024 * 1024

const writeConfig = (maxMemoryBytes: number): string => {
  const path = join(dir, `config-${maxMemoryBytes}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      hostId: "test-host",
      slug: "test-1",
      controlUrl: "ws://127.0.0.1:1",
      hostSecretFile: "/dev/null",
      meterUrl: "http://127.0.0.1:1",
      stateDir: "/tmp/unused-state",
      runDir: "/tmp/unused-run",
      nestDomain: "nest.test",
      agentVersion: "test",
      cloudHypervisor: "/bin/false",
      volumeTool: "/bin/false",
      guestImageDir: "/tmp/unused-image",
      volumeStore: "file:///tmp/unused-store",
      volumeKeyFile: null,
      scope: "none",
      template: { maxVcpus: 2, maxMemoryBytes },
      capacity: { vcpus: 2, memoryBytes: GIB },
      gpus: [],
      egressMbit: 1000,
      idleSuspendAfterMs: 600000,
      parkAfterMs: 3600000,
      backupIntervalMs: 3600000,
      meterIntervalMs: 60000,
      depcacheUrl: null,
      nixCacheUrl: null,
      nixCachePublicKey: null,
    }),
  )
  return path
}

describe("loadConfig template memory", () => {
  test("rejects a template max that cannot hot-plug above the boot memory", () => {
    expect(() => loadConfig(writeConfig(TEMPLATE_BOOT_MEMORY_BYTES))).toThrow("invalid config")
  })

  test("accepts a template max above the boot memory", () => {
    const config = loadConfig(writeConfig(TEMPLATE_BOOT_MEMORY_BYTES + GIB))
    expect(config.template.maxMemoryBytes).toBe(TEMPLATE_BOOT_MEMORY_BYTES + GIB)
  })
})

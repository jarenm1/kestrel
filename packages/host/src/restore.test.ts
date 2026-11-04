import { describe, expect, test } from "bun:test"
import { rewriteRestoreConfig } from "./restore"

const snapshot = () => ({
  cpus: { boot_vcpus: 2 },
  net: [{ tap: "kn-old", mac: "52:54:00:4b:4e:01" }],
  vsock: { cid: 9, socket: "/old/vsock.sock" },
  console: { mode: "Off" },
})

const target = {
  tap: "kn-7",
  cid: 9,
  vsockSocket: "/run/new/vsock.sock",
  consoleFile: "/run/new/console.log",
}

describe("restore config", () => {
  test("points the NIC, vsock and console at this VM and keeps every other field", () => {
    const rewritten = rewriteRestoreConfig(snapshot(), target)
    expect(rewritten.net).toEqual([{ tap: "kn-7", mac: "52:54:00:4b:4e:01" }])
    expect(rewritten.vsock).toEqual({ cid: 9, socket: "/run/new/vsock.sock" })
    expect(rewritten.console).toMatchObject({ mode: "File", file: "/run/new/console.log" })
    expect(rewritten.cpus).toEqual({ boot_vcpus: 2 })
  })

  test("does not modify the snapshot it was given", () => {
    const original = snapshot()
    rewriteRestoreConfig(original, target)
    expect(original).toEqual(snapshot())
  })

  test("refuses a snapshot without exactly one NIC", () => {
    expect(() => rewriteRestoreConfig({ ...snapshot(), net: [] }, target)).toThrow("exactly one NIC")
  })
})

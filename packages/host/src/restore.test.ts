import { describe, expect, test } from "bun:test"
import { rewriteRestoreConfig } from "./restore"

const snapshot = () => ({
  cpus: { boot_vcpus: 2 },
  net: [{ tap: "kn-old", mac: "52:54:00:4b:4e:01" }],
  vsock: { cid: 9, socket: "/old/vsock.sock" },
  console: { mode: "Off" },
  disks: [
    { id: "rootfs", path: "/nix/store/image.raw" },
    { id: "volume", path: "/old/volume.raw" },
    { id: "swap", path: "/old/swap.raw" },
  ],
})

const target = {
  tap: "kn-7",
  cid: 9,
  vsockSocket: "/run/new/vsock.sock",
  consoleFile: "/run/new/console.log",
  volumePath: "/dev/ublkb3",
  swapPath: "/new/swap.raw",
}

describe("restore config", () => {
  test("points the NIC, vsock and console at this VM and keeps every other field", () => {
    const rewritten = rewriteRestoreConfig(snapshot(), target)
    expect(rewritten.net).toEqual([{ tap: "kn-7", mac: "52:54:00:4b:4e:01" }])
    expect(rewritten.vsock).toEqual({ cid: 9, socket: "/run/new/vsock.sock" })
    expect(rewritten.console).toMatchObject({ mode: "File", file: "/run/new/console.log" })
    expect(rewritten.cpus).toEqual({ boot_vcpus: 2 })
  })

  test("points the volume and swap disks at this VM and leaves other disks alone", () => {
    const rewritten = rewriteRestoreConfig(snapshot(), target)
    expect(rewritten.disks).toEqual([
      { id: "rootfs", path: "/nix/store/image.raw" },
      { id: "volume", path: "/dev/ublkb3" },
      { id: "swap", path: "/new/swap.raw" },
    ])
  })

  test("a snapshot without disks keeps having none", () => {
    const { disks: _disks, ...bare } = snapshot()
    expect(JSON.stringify(rewriteRestoreConfig(bare, target))).not.toContain("disks")
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

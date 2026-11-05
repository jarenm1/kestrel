import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { buildBwrapArgv, gpuArgs, hasGpuDevice, prepareLaunch, type GpuProbe } from "."

const base = { workspacePath: "/w", cwd: "/w", mirrorDir: "/m", homeDir: "/h", env: {}, command: "true" }

/** A synthetic host: the device nodes it has and the driver directories that exist. */
const probe = (devices: ReadonlyArray<string>, dirs: ReadonlyArray<string> = []): GpuProbe => ({
  devices: () => devices,
  exists: (path) => dirs.includes(path),
})

const hasBind = (argv: ReadonlyArray<string>, from: string, to: string): boolean =>
  argv.some((arg, at) => arg === "--dev-bind" && argv[at + 1] === from && argv[at + 2] === to)

describe("headless GPU bwrap args", () => {
  test("exposes render and compute nodes, never modeset card nodes", () => {
    const argv = buildBwrapArgv({
      ...base,
      level: "basic",
      gpu: true,
      gpuProbe: probe(["/dev/dri/renderD128", "/dev/dri/card0", "/dev/nvidia0"], ["/run/opengl-driver"]),
    })
    expect(hasBind(argv, "/dev/dri/renderD128", "/dev/dri/renderD128")).toBe(true)
    expect(hasBind(argv, "/dev/nvidia0", "/dev/nvidia0")).toBe(true)
    expect(argv.join(" ")).not.toContain("/dev/dri/card0")
    expect(argv.join(" ")).not.toContain("/dev/dri/card")
    // The drivers Mesa and Vulkan load from.
    expect(argv.join(" ")).toContain("--ro-bind /run/opengl-driver /run/opengl-driver")
  })

  test("binds no X11 or audio socket and sets no DISPLAY, even when the caller passes one", () => {
    const argv = buildBwrapArgv({
      ...base,
      level: "basic",
      gpu: true,
      gpuProbe: probe(["/dev/dri/renderD128"]),
      env: { DISPLAY: ":0", PULSE_SERVER: "unix:/tmp/.X11-unix/pulse-0", KEEP: "yes" },
    })
    expect(argv).not.toContain("DISPLAY")
    expect(argv).not.toContain("PULSE_SERVER")
    expect(argv.join(" ")).not.toContain("/tmp/.X11-unix")
    // Other environment entries still reach the process.
    expect(argv[argv.indexOf("KEEP") + 1]).toBe("yes")
  })

  test("a CPU launch stays isolated even when the host has a GPU", () => {
    const argv = buildBwrapArgv({
      ...base,
      level: "basic",
      gpuProbe: probe(["/dev/dri/renderD128", "/dev/nvidia0"], ["/run/opengl-driver"]),
    })
    expect(argv).not.toContain("--dev-bind")
    expect(argv.join(" ")).not.toContain("/dev/dri")
    expect(argv.join(" ")).not.toContain("/run/opengl-driver")
  })

  test("a desktop keeps its GPU and its X socket", () => {
    const argv = buildBwrapArgv({
      ...base,
      level: "basic",
      display: 101,
      gpuProbe: probe(["/dev/dri/renderD128", "/dev/dri/card0", "/dev/nvidia-modeset"]),
    })
    expect(hasBind(argv, "/dev/dri/renderD128", "/dev/dri/renderD128")).toBe(true)
    expect(argv.join(" ")).toContain("--bind /tmp/.X11-unix/X101 /tmp/.X11-unix/X101")
    expect(argv.join(" ")).not.toContain("/dev/dri/card0")
    // Desktop launches bind the NVIDIA nodes they bound before the headless allow-list existed.
    expect(hasBind(argv, "/dev/nvidia-modeset", "/dev/nvidia-modeset")).toBe(true)
  })
})

describe("gpuArgs", () => {
  test("is empty without a GPU device, even when driver directories exist", () => {
    expect(gpuArgs(probe([], ["/sys/dev", "/run/opengl-driver"]))).toEqual([])
  })

  test("filters card nodes from a probe that lists them", () => {
    expect(gpuArgs(probe(["/dev/dri/card0"]))).toEqual([])
  })

  test("a headless launch never gets NVIDIA's modeset node, only the compute devices", () => {
    const argv = gpuArgs(
      probe(["/dev/nvidia0", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-modeset", "/dev/nvidia-caps"]),
      true,
    )
    expect(hasBind(argv, "/dev/nvidia0", "/dev/nvidia0")).toBe(true)
    expect(hasBind(argv, "/dev/nvidiactl", "/dev/nvidiactl")).toBe(true)
    expect(hasBind(argv, "/dev/nvidia-uvm", "/dev/nvidia-uvm")).toBe(true)
    expect(hasBind(argv, "/dev/nvidia-caps", "/dev/nvidia-caps")).toBe(true)
    expect(argv.join(" ")).not.toContain("nvidia-modeset")
  })

  test("a host whose only NVIDIA node is modeset has no usable GPU", () => {
    expect(hasGpuDevice(probe(["/dev/nvidia-modeset"]))).toBe(false)
  })

  test("reports GPU availability from the device list", () => {
    expect(hasGpuDevice(probe(["/dev/dri/renderD128"]))).toBe(true)
    expect(hasGpuDevice(probe([]))).toBe(false)
  })
})

describe("prepareLaunch headless GPU environment", () => {
  test("removes DISPLAY and PULSE_SERVER even when the caller passes them", async () => {
    const root = mkdtempSync(join(tmpdir(), "kestrel-headless-gpu-"))
    try {
      const launch = await Effect.runPromise(
        prepareLaunch({
          settings: { level: "off", binPath: null, sslCertFile: null, systemd: null, boxPort: 8787 },
          taskId: "task",
          gitIdentity: { name: "agent", email: "agent@example.invalid" },
          kind: "exec",
          workspacePath: root,
          mirrorDir: join(root, "mirror"),
          homeDir: join(root, "home"),
          display: null,
          gpu: true,
          env: { DISPLAY: ":0", PULSE_SERVER: "unix:/tmp/.X11-unix/pulse-0", KEEP: "yes" },
          command: "true",
        }),
      )
      expect(launch.env.DISPLAY).toBeUndefined()
      expect(launch.env.PULSE_SERVER).toBeUndefined()
      expect(launch.env.KEEP).toBe("yes")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG, serverEnv } from "./cli/config"
import { DEFAULT_ANTHROPIC_COMMAND, loadConfig, webRtcEnv } from "./config"

const BOX_VARS = [
  "CLOUDAGENTS_CONTROL_URL",
  "CLOUDAGENTS_BOX_ID",
  "CLOUDAGENTS_BOX_SECRET",
  "CLOUDAGENTS_BOX_MANAGED",
  "CLOUDAGENTS_BOX_TOKEN",
  "CLOUDAGENTS_PORT",
  "CLOUDAGENTS_HOST",
  "CLOUDAGENTS_SANDBOX_PORT",
  "CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS",
  "CLOUDAGENTS_TASK_MEMORY_MAX",
  "CLOUDAGENTS_TASK_MEMORY_HIGH",
  "CLOUDAGENTS_TASK_SWAP_MAX",
  "CLOUDAGENTS_BOX_SWAP_MAX",
] as const

const CONTROL = "https://control.example"
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of BOX_VARS) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

const configWith = (env: Record<string, string>) => {
  for (const name of BOX_VARS) delete process.env[name]
  Object.assign(process.env, env)
  return loadConfig()
}

describe("sandbox listener settings", () => {
  test("wildcard public binding never changes the loopback sandbox URL", () => {
    const config = configWith({ CLOUDAGENTS_HOST: "::", CLOUDAGENTS_PORT: "9000" })
    expect(config.sandboxPort).toBe(19000)
    expect(config.mcpBaseUrl).toBe("http://127.0.0.1:19000")
  })

  test("a separate port can be configured and invalid or shared ports are refused", () => {
    expect(configWith({ CLOUDAGENTS_PORT: "9000", CLOUDAGENTS_SANDBOX_PORT: "20000" }).sandboxPort).toBe(20000)
    for (const port of ["0", "65536", "1.5", "bad", "9000"]) {
      expect(() => configWith({ CLOUDAGENTS_PORT: "9000", CLOUDAGENTS_SANDBOX_PORT: port })).toThrow()
    }
  })
})

test("legacy noreply selection accepts only owner logins, case-insensitively", () => {
  expect(configWith({ CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS: " Alice, BOB " }).gitLegacyNoreplyUsers).toEqual(["alice", "bob"])
  expect(() => configWith({ CLOUDAGENTS_GIT_LEGACY_NOREPLY_USERS: "alice@example.com" })).toThrow("comma-separated GitHub logins")
})

describe("default Claude command", () => {
  test("the shell hands Claude Code the edit instructions as one argument", () => {
    const bin = mkdtempSync(join(tmpdir(), "claude-stub-"))
    try {
      writeFileSync(join(bin, "claude"), `#!/usr/bin/env sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done\n`)
      chmodSync(join(bin, "claude"), 0o755)
      const run = Bun.spawnSync(["sh", "-c", DEFAULT_ANTHROPIC_COMMAND], {
        env: { PATH: `${bin}:${process.env.PATH}`, CLOUDAGENTS_MCP_CONFIG: "/mcp.json" },
      })
      const args = run.stdout.toString().trim().split("\n")
      const instructions = args[args.indexOf("--append-system-prompt") + 1]
      expect(instructions).toStartWith("Change existing files with the Edit tool")
      expect(instructions).toEndWith("Python may not be installed here.")
      expect(args[args.indexOf("--mcp-config") + 1]).toBe("/mcp.json")
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe("managed box settings", () => {
  test("CLOUDAGENTS_BOX_MANAGED=1 needs the box id, its secret and the control plane URL", () => {
    const message = "CLOUDAGENTS_BOX_MANAGED=1 requires CLOUDAGENTS_BOX_ID, CLOUDAGENTS_BOX_SECRET and CLOUDAGENTS_CONTROL_URL"
    expect(() => configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_BOX_ID: "box", CLOUDAGENTS_BOX_SECRET: "s" })).toThrow(
      message,
    )
    expect(() =>
      configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_SECRET: "s" }),
    ).toThrow(message)
    expect(() => configWith({ CLOUDAGENTS_BOX_MANAGED: "1", CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_ID: "box" })).toThrow(
      message,
    )
  })

  test("a managed box is direct and marked managed", () => {
    const config = configWith({
      CLOUDAGENTS_CONTROL_URL: CONTROL,
      CLOUDAGENTS_BOX_ID: "box_fleet_1",
      CLOUDAGENTS_BOX_SECRET: "secret",
      CLOUDAGENTS_BOX_MANAGED: "1",
    })
    expect(config.direct).toEqual({ controlUrl: CONTROL, boxId: "box_fleet_1", boxSecret: "secret", managed: true })
    expect(config.relay).toBeNull()
  })

  test("the relay token and managed direct mode coexist", () => {
    const config = configWith({
      CLOUDAGENTS_CONTROL_URL: CONTROL,
      CLOUDAGENTS_BOX_ID: "box_fleet_1",
      CLOUDAGENTS_BOX_SECRET: "secret",
      CLOUDAGENTS_BOX_MANAGED: "1",
      CLOUDAGENTS_BOX_TOKEN: "relay-token",
    })
    expect(config.direct?.managed).toBe(true)
    expect(config.relay).toEqual({ controlUrl: CONTROL, boxToken: "relay-token" })
  })

  test("a user's own box stays unmanaged", () => {
    const config = configWith({ CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_ID: "box_own", CLOUDAGENTS_BOX_SECRET: "secret" })
    expect(config.direct).toEqual({ controlUrl: CONTROL, boxId: "box_own", boxSecret: "secret", managed: false })
  })

  test("without box id or secret there is no direct mode, and the relay needs only its token", () => {
    const config = configWith({ CLOUDAGENTS_CONTROL_URL: CONTROL, CLOUDAGENTS_BOX_TOKEN: "relay-token" })
    expect(config.direct).toBeNull()
    expect(config.relay).toEqual({ controlUrl: CONTROL, boxToken: "relay-token" })
  })

  test("a box id without the control plane URL is refused", () => {
    expect(() => configWith({ CLOUDAGENTS_BOX_ID: "box_own", CLOUDAGENTS_BOX_SECRET: "secret" })).toThrow(
      "CLOUDAGENTS_CONTROL_URL is required when CLOUDAGENTS_BOX_ID is set",
    )
  })
})

describe("webRtcEnv", () => {
  test("is always on, with one public STUN server assumed", () => {
    expect(webRtcEnv(false, {})).toEqual({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      turn: null,
      policy: "all",
      portRange: null,
      hostAddresses: [],
      denyPrivate: false,
    })
  })

  test("an empty ICE server list leaves no STUN or TURN server", () => {
    expect(webRtcEnv(false, { CLOUDAGENTS_WEBRTC_ICE_SERVERS: "[]" }).iceServers).toEqual([])
  })

  test("managed viewers cannot cause probes of private networks", () => {
    expect(webRtcEnv(true, {}).denyPrivate).toBe(true)
  })

  test("reads the box's network", () => {
    const settings = webRtcEnv(false, {
      CLOUDAGENTS_WEBRTC_ICE_SERVERS: '[{"urls":["stun:stun.example:3478"]}]',
      CLOUDAGENTS_WEBRTC_TURN_URLS: "turn:t.example:3478, turns:t.example:5349",
      CLOUDAGENTS_WEBRTC_TURN_SECRET: "s",
      CLOUDAGENTS_WEBRTC_ICE_POLICY: "relay",
      CLOUDAGENTS_WEBRTC_PORT_RANGE: "50000-50100",
      CLOUDAGENTS_WEBRTC_HOST_ADDRESSES: "100.64.0.5, 10.0.0.2",
    })
    expect(settings).toEqual({
      iceServers: [{ urls: ["stun:stun.example:3478"] }],
      turn: { urls: ["turn:t.example:3478", "turns:t.example:5349"], secret: "s" },
      policy: "relay",
      portRange: [50000, 50100],
      hostAddresses: ["100.64.0.5", "10.0.0.2"],
      denyPrivate: false,
    })
  })

  test("rejects a bad network", () => {
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_ICE_SERVERS: "stun:x" })).toThrow("JSON array")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_ICE_SERVERS: '[{"urls":["http://x"]}]' })).toThrow("must start with")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_TURN_SECRET: "s" })).toThrow("together")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_ICE_POLICY: "relay" })).toThrow("needs a TURN server")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_PORT_RANGE: "50000" })).toThrow("PORT_RANGE")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_PORT_RANGE: "50100-50000" })).toThrow("PORT_RANGE")
  })

  test("a managed box refuses to share a static TURN password", () => {
    const static_ = '[{"urls":["turn:t.example"],"username":"u","credential":"p"}]'
    expect(() => webRtcEnv(true, { CLOUDAGENTS_WEBRTC_ICE_SERVERS: static_ })).toThrow("managed box")
    expect(() => webRtcEnv(false, { CLOUDAGENTS_WEBRTC_ICE_SERVERS: static_ })).not.toThrow()
  })
})

describe("a user's box config", () => {
  test("uses the default STUN server unless the config names one", () => {
    expect(webRtcEnv(false, serverEnv(DEFAULT_CONFIG)).iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }])
  })

  test("turns its webrtc object into settings the server accepts", () => {
    const settings = webRtcEnv(
      false,
      serverEnv({
        ...DEFAULT_CONFIG,
        webrtc: {
          iceServers: [{ urls: ["stun:stun.example:3478"] }],
          turn: { urls: ["turn:t.example:3478"], secret: "s" },
          icePolicy: "relay",
          portRange: "50000-50100",
          hostAddresses: ["100.64.0.5"],
        },
      }),
    )
    expect(settings).toEqual({
      iceServers: [{ urls: ["stun:stun.example:3478"] }],
      turn: { urls: ["turn:t.example:3478"], secret: "s" },
      policy: "relay",
      portRange: [50000, 50100],
      hostAddresses: ["100.64.0.5"],
      denyPrivate: false,
    })
  })

  test("an empty webrtc object keeps the default STUN server", () => {
    expect(webRtcEnv(false, serverEnv({ ...DEFAULT_CONFIG, webrtc: {} }))).toMatchObject({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      turn: null,
    })
  })
})

describe("memory limits", () => {
  test("MemoryHigh defaults to 90% of the task's MemoryMax", () => {
    const config = configWith({ CLOUDAGENTS_TASK_MEMORY_MAX: "8G" })
    expect(config.systemd?.limits.memoryMax).toBe("8G")
    expect(config.systemd?.limits.memoryHigh).toBe(String(Math.floor(8 * 1024 ** 3 * 0.9)))
  })

  test("swap is off by default for tasks and the box", () => {
    const config = configWith({})
    expect(config.systemd?.limits.swapMax).toBe("0")
    expect(config.systemd?.box.swapMax).toBe("0")
  })

  test("explicit swap and MemoryHigh values are used as given", () => {
    const config = configWith({
      CLOUDAGENTS_TASK_SWAP_MAX: "1G",
      CLOUDAGENTS_TASK_MEMORY_HIGH: "infinity",
      CLOUDAGENTS_BOX_SWAP_MAX: "8G",
    })
    expect(config.systemd?.limits.swapMax).toBe("1G")
    expect(config.systemd?.limits.memoryHigh).toBe("infinity")
    expect(config.systemd?.box.swapMax).toBe("8G")
  })

  test("a value that is not a systemd limit is refused", () => {
    expect(() => configWith({ CLOUDAGENTS_TASK_SWAP_MAX: "1 G" })).toThrow(
      "CLOUDAGENTS_TASK_SWAP_MAX must be a systemd limit value",
    )
  })
})

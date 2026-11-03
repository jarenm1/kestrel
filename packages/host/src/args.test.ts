import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { UsageError } from "./errors"
import { parseCommand } from "./args"
import { runCli } from "./cli"
import { makeTempDir, type TempDir } from "./test-support"

let tmp: TempDir

beforeEach(() => {
  tmp = makeTempDir("args")
})

afterEach(() => tmp.dispose())

describe("parseCommand", () => {
  test("create applies the documented defaults", () => {
    expect(parseCommand(["vm", "create", "--user", "alice", "--os-image", "/tmp/base.raw"])).toEqual({
      kind: "create",
      userId: "alice",
      osImage: "/tmp/base.raw",
      shape: { cpus: 2, memoryMb: 2048 },
      volumeGb: 20,
    })
  })

  test("create accepts explicit shape and volume size", () => {
    const parsed = parseCommand([
      "vm",
      "create",
      "--user",
      "bob",
      "--os-image",
      "/tmp/base.raw",
      "--cpus",
      "4",
      "--memory-mb",
      "4096",
      "--volume-gb",
      "50",
    ])
    expect(parsed).toEqual({
      kind: "create",
      userId: "bob",
      osImage: "/tmp/base.raw",
      shape: { cpus: 4, memoryMb: 4096 },
      volumeGb: 50,
    })
  })

  test("create refuses memory above the 4096 MB launcher limit", () => {
    expect(() =>
      parseCommand(["vm", "create", "--user", "alice", "--os-image", "/tmp/base.raw", "--memory-mb", "8192"]),
    ).toThrow(UsageError)
  })

  test("create requires --user and --os-image", () => {
    expect(() => parseCommand(["vm", "create", "--os-image", "/tmp/base.raw"])).toThrow(UsageError)
    expect(() => parseCommand(["vm", "create", "--user", "alice"])).toThrow(UsageError)
  })

  test("stop converts --timeout seconds to milliseconds and reads --force", () => {
    const vmId = randomUUID()
    expect(parseCommand(["vm", "stop", vmId, "--timeout", "5", "--force"])).toEqual({
      kind: "stop",
      vmId,
      timeoutMs: 5000,
      force: true,
    })
    expect(parseCommand(["vm", "stop", vmId])).toEqual({ kind: "stop", vmId, timeoutMs: 120_000, force: false })
  })

  test("destroy requires --yes", () => {
    expect(() => parseCommand(["vm", "destroy", randomUUID()])).toThrow(UsageError)
    expect(parseCommand(["vm", "destroy", randomUUID(), "--yes"]).kind).toBe("destroy")
  })

  test("vm ids must be UUID v4", () => {
    expect(() => parseCommand(["vm", "show", "not-a-uuid"])).toThrow(UsageError)
    expect(() => parseCommand(["vm", "start", "../etc"])).toThrow(UsageError)
  })

  test("unknown commands and stray arguments are usage errors", () => {
    expect(() => parseCommand(["bogus"])).toThrow(UsageError)
    expect(() => parseCommand(["vm", "list", "extra"])).toThrow(UsageError)
  })

  test("reconcile, list, init parse with no arguments", () => {
    expect(parseCommand(["reconcile"])).toEqual({ kind: "reconcile" })
    expect(parseCommand(["vm", "list"])).toEqual({ kind: "list" })
    expect(parseCommand(["init"])).toEqual({ kind: "init" })
  })
})

describe("runCli exit codes", () => {
  test("usage errors exit 2 without touching the state directory", async () => {
    const env = { KESTREL_HOST_HOME: tmp.path }
    expect(await runCli(["vm", "destroy", randomUUID()], env)).toBe(2)
    expect(await runCli(["vm", "show", "nope"], env)).toBe(2)
  })

  test("list succeeds on an empty state directory", async () => {
    expect(await runCli(["vm", "list"], { KESTREL_HOST_HOME: tmp.path })).toBe(0)
  })
})

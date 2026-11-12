import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { TOOLKIT_BIN } from "."
import { installNixPackage, installToolkit } from "./toolkits"

let root: string
let home: string
let argsFile: string
let savedPath: string | undefined

// A stand-in `nix` that records its arguments and makes the out-link `nix build` would, to a package with bin/hello.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kestrel-toolkits-"))
  home = join(root, "home")
  argsFile = join(root, "args")
  const pkg = join(root, "pkg")
  mkdirSync(join(pkg, "bin"), { recursive: true })
  writeFileSync(join(pkg, "bin", "hello"), "")
  mkdirSync(join(root, "fakebin"))
  const nix = join(root, "fakebin", "nix")
  writeFileSync(nix, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nln -s '${pkg}' "$3"\n`)
  chmodSync(nix, 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${join(root, "fakebin")}:${savedPath ?? ""}`
})

afterEach(() => {
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

const recordedArgs = () => readFileSync(argsFile, "utf8").trimEnd().split("\n")

test("installNixPackage builds from the box flake's nixpkgs without local builds and links the executables", async () => {
  const exes = await Effect.runPromise(installNixPackage("/flake", home, "python3Packages.requests"))
  const outLink = join(home, ".kestrel/toolkits/nixpkgs.python3Packages.requests/out")
  expect(recordedArgs()).toEqual([
    "build",
    "--out-link",
    outLink,
    "--inputs-from",
    "/flake",
    "--max-jobs",
    "0",
    "nixpkgs#python3Packages.requests",
  ])
  expect(exes).toEqual(["hello"])
  expect(readlinkSync(join(home, TOOLKIT_BIN, "hello"))).toBe("../toolkits/nixpkgs.python3Packages.requests/out/bin/hello")
})

test("installNixPackage refuses anything but a nixpkgs attribute path, before running nix", async () => {
  for (const attr of ["nixpkgs#hello", "github:evil/flake#x", "../hello", "a/b", "hello world", ".hello", "hello.", "a..b", ""]) {
    const exit = await Effect.runPromiseExit(installNixPackage("/flake", home, attr))
    expect(Exit.isFailure(exit)).toBe(true)
  }
  expect(existsSync(argsFile)).toBe(false)
})

test("installToolkit still builds the flake's toolkit package", async () => {
  const exes = await Effect.runPromise(installToolkit("/flake", home, "blender"))
  expect(recordedArgs()).toEqual(["build", "--out-link", join(home, ".kestrel/toolkits/blender/out"), "/flake#toolkit-blender"])
  expect(exes).toEqual(["hello"])
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { TOOLKIT_BIN } from "."
import { installNixPackage, installToolkit, shadowedExes } from "./toolkits"

let root: string
let home: string
let argsFile: string
let failFile: string
let pkg: string
let other: string
let savedPath: string | undefined

/**
 * A stand-in `nix build`: records its arguments, makes the out-link, and with --print-out-paths prints the store path.
 * `nixpkgs#other` is a second package; a store path argument (the rooting step) links to that path. It fails while
 * `failFile` exists.
 */
const FAKE_NIX = (argsFile: string, failFile: string, pkg: string, other: string) => `#!/bin/sh
printf '%s\\n' "$*" >> '${argsFile}'
if [ -e '${failFile}' ]; then echo "error: Unable to start any build" >&2; exit 1; fi
out=; print=; target='${pkg}'; prev=
for a in "$@"; do
  if [ "$prev" = "--out-link" ]; then out=$a
  elif [ "$a" = "--print-out-paths" ]; then print=1
  elif [ "$a" = "nixpkgs#other" ]; then target='${other}'
  else case "$a" in /*) target=$a ;; esac
  fi
  prev=$a
done
ln -s "$target" "$out"
if [ -n "$print" ]; then echo "$target"; fi
`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kestrel-toolkits-"))
  home = join(root, "home")
  argsFile = join(root, "args")
  failFile = join(root, "fail")
  pkg = join(root, "pkg")
  other = join(root, "other")
  mkdirSync(join(pkg, "bin"), { recursive: true })
  writeFileSync(join(pkg, "bin", "hello"), "")
  writeFileSync(join(pkg, "bin", "extra"), "")
  mkdirSync(join(other, "bin"), { recursive: true })
  writeFileSync(join(other, "bin", "hello"), "")
  mkdirSync(join(root, "fakebin"))
  const nix = join(root, "fakebin", "nix")
  writeFileSync(nix, FAKE_NIX(argsFile, failFile, pkg, other))
  chmodSync(nix, 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${join(root, "fakebin")}:${savedPath ?? ""}`
})

afterEach(() => {
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

const calls = () => readFileSync(argsFile, "utf8").trimEnd().split("\n")
const toolkits = () => join(home, ".kestrel/toolkits")

test("installNixPackage builds from the box flake's nixpkgs without local builds, then roots and links the result", async () => {
  const installed = await Effect.runPromise(installNixPackage("flake-ref", home, "python3Packages.requests"))
  const dir = join(toolkits(), "nixpkgs.python3Packages.requests")
  expect(calls()).toEqual([
    `build --print-out-paths --out-link ${dir}.new/out --inputs-from flake-ref --max-jobs 0 nixpkgs#python3Packages.requests`,
    `build --out-link ${dir}/out ${pkg}`,
  ])
  expect(installed).toEqual({ dir: ".kestrel/toolkits/nixpkgs.python3Packages.requests", exes: ["extra", "hello"], replaced: [] })
  expect(readlinkSync(join(dir, "out"))).toBe(pkg)
  expect(existsSync(`${dir}.new`)).toBe(false)
  expect(readlinkSync(join(home, TOOLKIT_BIN, "hello"))).toBe("../toolkits/nixpkgs.python3Packages.requests/out/bin/hello")
})

test("installNixPackage refuses anything but a nixpkgs attribute path, before running nix", async () => {
  for (const attr of ["nixpkgs#hello", "github:evil/flake#x", "../hello", "a/b", "hello world", ".hello", "hello.", "a..b", ""]) {
    const exit = await Effect.runPromiseExit(installNixPackage("flake-ref", home, attr))
    expect(Exit.isFailure(exit)).toBe(true)
  }
  expect(existsSync(argsFile)).toBe(false)
})

test("installToolkit still builds the flake's toolkit package", async () => {
  await Effect.runPromise(installToolkit("flake-ref", home, "blender"))
  expect(calls()[0]).toBe(`build --print-out-paths --out-link ${join(toolkits(), "blender")}.new/out flake-ref#toolkit-blender`)
})

test("a failed reinstall keeps the previous install and its commands", async () => {
  await Effect.runPromise(installNixPackage("flake-ref", home, "jq"))
  writeFileSync(failFile, "")
  const exit = await Effect.runPromiseExit(installNixPackage("flake-ref", home, "jq"))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).toContain("Unable to start any build")
  expect(readlinkSync(join(toolkits(), "nixpkgs.jq", "out"))).toBe(pkg)
  expect(existsSync(join(home, TOOLKIT_BIN, "hello"))).toBe(true)
  expect(existsSync(join(toolkits(), "nixpkgs.jq.new"))).toBe(false)
})

test("an install reports the links it takes over, and links whose target is gone are removed", async () => {
  await Effect.runPromise(installToolkit("flake-ref", home, "blender"))
  const taken = await Effect.runPromise(installNixPackage("flake-ref", home, "other"))
  expect(taken.replaced).toEqual(["hello (blender)"])
  expect(readlinkSync(join(home, TOOLKIT_BIN, "hello"))).toBe("../toolkits/nixpkgs.other/out/bin/hello")

  // A new version of the toolkit without `extra`: its old link would dangle.
  rmSync(join(pkg, "bin", "extra"))
  const again = await Effect.runPromise(installToolkit("flake-ref", home, "blender"))
  expect(again.exes).toEqual(["hello"])
  expect(again.replaced).toEqual(["hello (nixpkgs.other)"])
  expect(existsSync(join(home, TOOLKIT_BIN, "extra"))).toBe(false)
})

test("shadowedExes names the executables an earlier PATH entry already has", () => {
  expect(shadowedExes(["nix", "surely-not-a-command"], join(root, "fakebin"))).toEqual(["nix"])
})

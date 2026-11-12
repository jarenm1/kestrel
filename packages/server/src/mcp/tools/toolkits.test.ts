import { expect, test } from "bun:test"
import { describeInstall } from "./toolkits"

test("a library install points at its files instead of PATH", () => {
  expect(describeInstall("python3Packages.requests", { dir: ".kestrel/toolkits/nixpkgs.python3Packages.requests", exes: [], replaced: [], shadowed: [] })).toBe(
    "installed python3Packages.requests; it has no executables. Its files are under ~/.kestrel/toolkits/nixpkgs.python3Packages.requests/ (e.g. for PYTHONPATH).",
  )
})

test("an install names the links it took over and the commands the sandbox's own copy shadows", () => {
  const text = describeInstall("nodejs", {
    dir: ".kestrel/toolkits/nixpkgs.nodejs",
    exes: ["node", "npm", "xdg-open"],
    replaced: ["xdg-open (roblox-studio)"],
    shadowed: ["node", "npm"],
  })
  expect(text).toContain("on PATH: node, npm, xdg-open")
  expect(text).toContain("replaced another install's command: xdg-open (roblox-studio)")
  expect(text).toContain("the sandbox already has its own: node, npm")
})

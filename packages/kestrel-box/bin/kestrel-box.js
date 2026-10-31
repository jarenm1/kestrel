#!/usr/bin/env node
"use strict";

// Downloads the matching kestrel-box release binary once, caches it, and runs it with the same arguments.

const { spawn } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { version } = require("../package.json");

const fail = (message) => {
  console.error(`kestrel-box: ${message}`);
  process.exit(1);
};

if (process.platform === "win32") {
  fail("the box runs on Windows through WSL2; run the install-box.ps1 script from the Kestrel repository");
}
const os = process.platform;
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (os !== "linux" && os !== "darwin") fail(`unsupported OS ${os}`);
if (arch === undefined) fail(`unsupported architecture ${process.arch}`);

const base =
  process.env.KESTREL_BOX_DOWNLOAD_BASE ?? `https://github.com/jarenm1/kestrel/releases/download/box-v${version}`;
const cacheDir = join(homedir(), ".cache", "kestrel-box", version);
const binary = join(cacheDir, `kestrel-box-${os}-${arch}`);

const ensureBinary = async () => {
  if (existsSync(binary)) return binary;
  const url = `${base}/kestrel-box-${os}-${arch}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  mkdirSync(cacheDir, { recursive: true });
  const tmp = `${binary}.${process.pid}.tmp`;
  writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
  chmodSync(tmp, 0o755);
  renameSync(tmp, binary);
  return binary;
};

ensureBinary()
  .then((path) => {
    const child = spawn(path, process.argv.slice(2), { stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      process.on(signal, () => child.kill(signal));
    }
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        for (const s of signals) process.removeAllListeners(s);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  })
  .catch((error) => fail(error.message));

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import xdamageSource from "../../native/xdamage-capture.c" with { type: "text" }
import { DESKTOP_HELPER } from "../desktop/requirements"
import { CliError, exec } from "./system"

/** Where the desktop helper lives; `run` puts this directory first on PATH so the server finds it. */
export const desktopBinDir = (): string => join(homedir(), ".local", "share", "kestrel", "bin")

export const desktopHelperPath = (): string => join(desktopBinDir(), DESKTOP_HELPER)

/** Compiles the embedded `xdamage-capture.c` into `desktopBinDir()`, the way flake.nix builds it. */
export const buildDesktopHelper = (): void => {
  const cc = process.env.CC ?? "cc"
  const work = mkdtempSync(join(tmpdir(), "kestrel-box-xdamage-"))
  try {
    const source = join(work, "xdamage-capture.c")
    const built = join(work, "xdamage-capture")
    writeFileSync(source, xdamageSource)
    const result = exec(
      cc,
      ["-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", built, source, "-lX11", "-lXext", "-lXdamage", "-lXfixes"],
      120_000,
    )
    if (result.status !== 0) {
      const reason = result.status === null ? `${cc} did not start` : result.stderr.trim()
      throw new CliError(
        `compiling xdamage-capture failed: ${reason}\n` +
          "install the build tools and X11 headers: sudo apt install build-essential libx11-dev libxext-dev libxdamage-dev libxfixes-dev",
      )
    }
    mkdirSync(desktopBinDir(), { recursive: true })
    const staged = `${desktopHelperPath()}.new`
    copyFileSync(built, staged)
    chmodSync(staged, 0o755)
    renameSync(staged, desktopHelperPath())
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

import { readFileSync } from "node:fs"

/** WSL's kernel identifies itself in /proc; environment variables may be absent in services. */
export const isWslKernel = (release: string): boolean => /microsoft|wsl/i.test(release)

export const isWsl = (): boolean => {
  try {
    return isWslKernel(readFileSync("/proc/sys/kernel/osrelease", "utf8"))
  } catch {
    return false
  }
}

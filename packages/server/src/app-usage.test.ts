import { describe, expect, test } from "bun:test"
import { appName, groupApps, MAX_APPS, otherMemory, type ProcessReading } from "./app-usage"

describe("appName", () => {
  test("a runtime is named after the package or file of the script it runs", () => {
    expect(appName(["/nix/store/x-nodejs/bin/node", "/w/node_modules/vite/bin/vite.js", "build"], "node")).toBe("node · vite")
    expect(appName(["node", "--max-old-space-size=8192", "/w/node_modules/typescript/bin/tsc"], "node")).toBe("node · typescript")
    expect(appName(["node", "/w/node_modules/@openai/codex/bin/codex.js"], "node")).toBe("node · @openai/codex")
    expect(appName(["node", "/w/node_modules/.bin/next", "dev"], "node")).toBe("node · next")
    expect(appName(["bun", "scripts/dev.ts"], "bun")).toBe("bun · dev")
    expect(appName(["python3", "-u", "train.py"], "python3")).toBe("python3 · train")
    expect(appName(["python3", "-m", "http.server", "8000"], "python3")).toBe("python3 · http.server")
  })

  test("a runtime with no script is the runtime; other programs are their own name", () => {
    expect(appName(["node"], "node")).toBe("node")
    expect(appName(["node", "-e", "1"], "node")).toBe("node")
    expect(appName(["python", "-c", "print(1)"], "python")).toBe("python")
    expect(appName(["/usr/bin/codex", "app-server"], "codex")).toBe("codex")
    expect(appName(["/nix/store/x-blender/bin/.blender-wrapped"], ".blender-wrappe")).toBe("blender")
    expect(appName([""], "kworker")).toBe("kworker")
  })
})

const proc = (key: string, name: string, memory: number, cpuUsec: number, shmem = 0): ProcessReading => ({
  key,
  name,
  memory,
  shmem,
  cpuUsec,
})

describe("otherMemory", () => {
  test("with the processes' memory it adds up to the slice's memory.current", () => {
    // anon 600 (all mapped), file 300 of which shmem 100, 40 of the shmem mapped by a process, kernel 50.
    const processes = [proc("1:1", "node", 400, 0), proc("2:1", "node", 240, 0, 40)]
    const stat = "anon 600\nfile 300\nkernel 50\nshmem 100\nfile_mapped 20\n"
    const other = otherMemory(950, stat, processes)
    expect(other).toEqual({ pageCache: 200, tmpfs: 60, kernel: 50 })
    const apps = groupApps(processes, new Map(), 1)
    expect(apps.reduce((n, a) => n + a.ramUsed, 0) + other.pageCache + other.tmpfs + other.kernel).toBe(950)
  })
})

describe("groupApps", () => {
  test("sums each program's processes and counts CPU since the previous reading", () => {
    const apps = groupApps(
      [proc("1:1", "node · vite", 300, 1_500_000), proc("2:1", "node · vite", 200, 400_000), proc("3:1", "codex", 100, 50_000)],
      // pid 2 started since the previous reading, so all of its CPU time is new.
      new Map([
        ["1:1", 1_000_000],
        ["3:1", 0],
      ]),
      2_000_000,
    )
    expect(apps).toEqual([
      { name: "node · vite", processes: 2, ramUsed: 500, cpu: 0.45 },
      { name: "codex", processes: 1, ramUsed: 100, cpu: 0.025 },
    ])
  })

  test("a reused pid is a new process", () => {
    const [app] = groupApps([proc("1:9", "sh", 1, 100)], new Map([["1:1", 1_000_000]]), 1_000)
    expect(app?.cpu).toBe(0.1)
  })

  test("groups past the largest are summed into one unnamed entry", () => {
    const processes = Array.from({ length: MAX_APPS + 2 }, (_, i) => proc(`${i}:1`, `app${i}`, 1000 - i, 0))
    const apps = groupApps(processes, new Map(), 1)
    expect(apps).toHaveLength(MAX_APPS + 1)
    expect(apps.slice(0, MAX_APPS).map((a) => a.name)).toEqual(processes.slice(0, MAX_APPS).map((p) => p.name))
    expect(apps.at(-1)).toEqual({ name: null, processes: 2, ramUsed: 1000 - MAX_APPS + (1000 - MAX_APPS - 1), cpu: 0 })
  })
})

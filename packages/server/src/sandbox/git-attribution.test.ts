import { expect, test } from "bun:test"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareLaunch } from "."

// Exercise actual commits through the same launch used by runs, tools and desktop terminals.
test("task commits use their owner, not a stale home identity or another task's owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-attribution-"))
  const git = Bun.which("git") as string
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  try {
    for (const owner of ["alice", "bob"]) {
      const workspace = join(root, owner)
      const home = join(root, `${owner}-home`)
      mkdirSync(workspace)
      mkdirSync(home)
      const config = join(home, ".gitconfig")
      writeFileSync(config, "[user]\n\tname = Unrelated Person\n\temail = unrelated@example.com\n")
      const launch = await Effect.runPromise(prepareLaunch({
        settings: { level: "off", binPath: null, sslCertFile: null, systemd: null, boxPort: 19001 },
        taskId: owner,
        owner,
        kind: "run",
        workspacePath: workspace,
        homeDir: home,
        mirrorDir: join(root, "mirror"),
        display: null,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config },
        command: `${quote(git)} init -q && ${quote(git)} commit --allow-empty -qm ordinary && ${quote(git)} log -1 --format='%an <%ae>|%cn <%ce>' && ${quote(git)} commit --allow-empty --author='Original Author <original@example.com>' -qm imported && ${quote(git)} log -1 --format='%an <%ae>|%cn <%ce>'`,
      }))
      const result = spawnSync(launch.file, [...launch.args], { cwd: launch.cwd, env: { ...launch.env }, encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split(/\r?\n/)).toEqual([
        `${owner} <${owner}@users.noreply.github.com>|${owner} <${owner}@users.noreply.github.com>`,
        `Original Author <original@example.com>|${owner} <${owner}@users.noreply.github.com>`,
      ])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

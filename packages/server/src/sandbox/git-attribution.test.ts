import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareLaunch } from "."
import { Config, type ServerConfig } from "../config"
import { GitHub, GitHubLive } from "../github/api"

// Exercise actual commits through the same launch used by runs, tools and desktop terminals.
test("task commits use their owner, not a stale home identity or another task's owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-attribution-"))
  const git = Bun.which("git") as string
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const profiles = { alice: { login: "alice", id: 156641090 }, bob: { login: "bob", id: 12345 } }
  const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    const login = new URL(request.url).pathname.slice("/users/".length)
    return Response.json(profiles[login as keyof typeof profiles])
  } })
  const github = await Effect.runPromise(GitHub.pipe(Effect.provide(
    GitHubLive.pipe(Layer.provide(Layer.succeed(Config, {
      githubApiUrl: api.url.origin,
      gitLegacyNoreplyUsers: ["BOB"],
    } as unknown as ServerConfig))),
  )))
  try {
    for (const owner of ["alice", "bob"] as const) {
      const workspace = join(root, owner)
      const home = join(root, `${owner}-home`)
      mkdirSync(workspace)
      mkdirSync(home)
      const config = join(home, ".gitconfig")
      writeFileSync(config, "[user]\n\tname = Unrelated Person\n\temail = unrelated@example.com\n")
      const launch = await Effect.runPromise(prepareLaunch({
        settings: { level: "off", binPath: null, sslCertFile: null, systemd: null, boxPort: 19001 },
        taskId: owner,
        gitIdentity: await Effect.runPromise(github.commitIdentity(owner)),
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
        owner === "alice"
          ? "alice <156641090+alice@users.noreply.github.com>|alice <156641090+alice@users.noreply.github.com>"
          : "bob <bob@users.noreply.github.com>|bob <bob@users.noreply.github.com>",
        owner === "alice"
          ? "Original Author <original@example.com>|alice <156641090+alice@users.noreply.github.com>"
          : "Original Author <original@example.com>|bob <bob@users.noreply.github.com>",
      ])
    }
  } finally {
    api.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

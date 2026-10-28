import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import type { ServerConfig } from "../config"
import { migrateLegacyState } from "./migrate"
import { checkoutPinRef, WorkspaceLive, WorkspaceService, type WorkspaceShape } from "./workspace"

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}
const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim()

const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "box-workspace-"))
  roots.push(root)
  return root
}

const withWorkspace = <A>(f: (ws: WorkspaceShape) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(Effect.provide(Effect.flatMap(WorkspaceService, f), WorkspaceLive))

/** A remote with one commit on `main`. */
const makeRemote = async (root: string): Promise<string> => {
  const origin = join(root, "origin.git")
  const seed = join(root, "seed")
  git(root, ["init", "--bare", "-b", "main", origin])
  git(root, ["init", "-b", "main", seed])
  await writeFile(join(seed, "README.md"), "hello\n")
  git(seed, ["add", "."])
  git(seed, ["commit", "-m", "init"])
  git(seed, ["push", origin, "main"])
  return origin
}

/** One checkout of `origin` in a thread, on a fresh branch forked from `main`. */
const makeCheckout = async (root: string, origin: string) => {
  const mirrorPath = join(root, "mirrors", "origin.git")
  const threadDir = join(root, "threads", "t1")
  const dir = join(threadDir, "repo")
  const shadowPath = join(root, "shadows", "t1", "c1.git")
  const pinRef = checkoutPinRef("t1", "c1")
  const head = await withWorkspace((ws) =>
    Effect.gen(function* () {
      yield* ws.syncMirror({ mirrorPath, url: origin })
      const sha = yield* ws.resolveRef(mirrorPath, "refs/heads/main")
      if (sha === null) return yield* Effect.die("mirror has no main")
      yield* ws.createCheckout({
        threadDir,
        dir,
        shadowPath,
        mirrorPath,
        url: origin,
        branch: "cloudagents/t1",
        startSha: sha,
        baseSha: sha,
        pinRef,
      })
      return sha
    }),
  )
  return { spec: { threadDir, dir, shadowPath }, pinRef, head }
}

describe("checkout git runs in the shadow", () => {
  test("diff covers commits, staged, unstaged and untracked changes against the pinned base", async () => {
    const root = await newRoot()
    const origin = await makeRemote(root)
    const co = await makeCheckout(root, origin)

    await writeFile(join(co.spec.dir, "committed.txt"), "c\n")
    git(co.spec.dir, ["add", "committed.txt"])
    git(co.spec.dir, ["commit", "-m", "add committed"])
    await writeFile(join(co.spec.dir, "staged.txt"), "s\n")
    git(co.spec.dir, ["add", "staged.txt"])
    await writeFile(join(co.spec.dir, "README.md"), "changed\n")
    await writeFile(join(co.spec.dir, "untracked.txt"), "u\n")

    const diff = await withWorkspace((ws) => ws.diff({ ...co.spec, baseRef: co.pinRef }))
    for (const name of ["committed.txt", "staged.txt", "README.md", "untracked.txt"]) {
      expect(diff).toContain(name)
    }
  })

  test("the checkout's own .git config and hooks never run on the host", async () => {
    const root = await newRoot()
    const origin = await makeRemote(root)
    const co = await makeCheckout(root, origin)
    const marker = join(root, "pwned")
    // The agent's own commit runs before the hostile config is written, so only host git can trip the marker.
    await writeFile(join(co.spec.dir, "README.md"), "agent commit\n")
    git(co.spec.dir, ["commit", "-am", "agent commit"])

    const evilHooks = join(root, "evil-hooks")
    await mkdir(evilHooks)
    await writeFile(join(evilHooks, "pre-push"), `#!/bin/sh\ntouch ${marker}\n`)
    await chmod(join(evilHooks, "pre-push"), 0o755)
    const gitDir = join(co.spec.dir, ".git")
    await appendFile(
      join(gitDir, "config"),
      [
        "[core]",
        `\tfsmonitor = touch ${marker}`,
        `\thooksPath = ${evilHooks}`,
        `[url "${join(root, "nowhere")}"]`,
        `\tinsteadOf = ${origin}`,
        `[diff "evil"]`,
        `\ttextconv = touch ${marker}`,
        "",
      ].join("\n"),
    )
    await writeFile(join(co.spec.dir, ".gitattributes"), "README.md diff=evil\n")
    await writeFile(join(co.spec.dir, "README.md"), "uncommitted edit\n")

    await withWorkspace((ws) => ws.diff({ ...co.spec, baseRef: co.pinRef }))
    const head = await withWorkspace((ws) => ws.headSha(co.spec))
    await withWorkspace((ws) => ws.pushBranch({ ...co.spec, url: origin, branch: "cloudagents/t1", head }))

    expect(existsSync(marker)).toBe(false)
    expect(git(origin, ["rev-parse", "refs/heads/cloudagents/t1"])).toBe(head)
  })

  test("a checkout whose .git points outside the thread workspace is refused", async () => {
    const root = await newRoot()
    const origin = await makeRemote(root)
    const co = await makeCheckout(root, origin)
    // A real repository outside the workspace, so the diff would succeed without the guard.
    const outside = join(root, "outside")
    git(root, ["clone", origin, outside])
    await rm(join(co.spec.dir, ".git"), { recursive: true, force: true })
    await symlink(join(outside, ".git"), join(co.spec.dir, ".git"))

    const exit = await Effect.runPromiseExit(
      Effect.provide(Effect.flatMap(WorkspaceService, (ws) => ws.diff({ ...co.spec, baseRef: co.pinRef })), WorkspaceLive),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("legacy state migration", () => {
  test("keeps a legacy task's committed and uncommitted files in one checkout", async () => {
    const root = await newRoot()
    const origin = await makeRemote(root)
    const dataDir = join(root, "data")
    const stateFile = join(dataDir, "state.json")
    const legacyClone = join(dataDir, "repos", "r1")
    await mkdir(join(dataDir, "repos"), { recursive: true })
    git(root, ["clone", origin, legacyClone])
    git(legacyClone, ["checkout", "-b", "cloudagents/x"])
    await writeFile(join(legacyClone, "feature.txt"), "f\n")
    git(legacyClone, ["add", "."])
    git(legacyClone, ["commit", "-m", "feature"])
    const legacyWorktree = join(dataDir, "worktrees", "t1")
    await mkdir(legacyWorktree, { recursive: true })
    // A real legacy worktree holds its branch's committed files too; the migration mirrors the whole tree.
    await writeFile(join(legacyWorktree, "feature.txt"), "f\n")
    await writeFile(join(legacyWorktree, "notes.txt"), "uncommitted\n")
    const now = new Date().toISOString()
    await writeFile(
      stateFile,
      JSON.stringify({
        repos: [
          {
            id: "r1",
            name: "widget",
            url: "https://github.com/acme/widget.git",
            localPath: legacyClone,
            defaultBranch: "main",
            createdAt: now,
            owner: "alice",
          },
        ],
        tasks: [
          {
            id: "t1",
            repoId: "r1",
            title: "Fix",
            branch: "cloudagents/x",
            baseBranch: "main",
            worktreePath: legacyWorktree,
            status: "done",
            createdAt: now,
            updatedAt: now,
          },
        ],
        messages: [],
        runs: [],
      }),
    )
    const config = {
      stateFile,
      dataDir,
      mirrorsDir: join(dataDir, "mirrors"),
      threadsDir: join(dataDir, "threads"),
      shadowsDir: join(dataDir, "shadows"),
    } as ServerConfig

    await Effect.runPromise(Effect.provide(migrateLegacyState(config), WorkspaceLive))

    const migrated = JSON.parse(await readFile(stateFile, "utf8"))
    expect(migrated.repos).toBeUndefined()
    expect(migrated.tasks).toHaveLength(1)
    const [task] = migrated.tasks
    expect(task.owner).toBe("alice")
    expect(task.checkouts).toHaveLength(1)
    expect(task.checkouts[0].dir).toBe("widget")
    expect(task.checkouts[0].branch).toBe("cloudagents/x")
    const dir = join(config.threadsDir, "t1", "widget")
    expect(await readFile(join(dir, "feature.txt"), "utf8")).toBe("f\n")
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("uncommitted\n")
    expect(existsSync(join(dataDir, "state.legacy.json"))).toBe(true)
  })
})

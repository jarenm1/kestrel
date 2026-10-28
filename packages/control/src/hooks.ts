/**
 * The `github_hooks` table: one webhook per repository, kept in the Hub. Kept apart from the Hub class so the
 * conditional write can be exercised against a plain SQLite database.
 */

export interface HookRow {
  readonly hookId: number
  readonly secret: string
}

/** The slice of `SqlStorage` the hook table needs. */
export interface HookSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] }
}

/**
 * Stores a freshly created webhook for `repo` and returns the row that is stored afterwards. The row is written
 * only while it still holds `expectedHookId` (null: only while there is no row), so when two requests race to
 * create a hook for one repository the first write wins and the loser can see it was not stored (the returned
 * row has a different `hookId`) and delete its own hook.
 */
export const claimHookRow = (
  sql: HookSql,
  repo: string,
  expectedHookId: number | null,
  hookId: number,
  secret: string,
): HookRow => {
  sql.exec(
    `INSERT INTO github_hooks (repo, hook_id, secret) VALUES (?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET hook_id = excluded.hook_id, secret = excluded.secret
     WHERE github_hooks.hook_id IS ?`,
    repo,
    hookId,
    secret,
    expectedHookId,
  )
  const row = sql.exec<{ hookId: number; secret: string }>(
    "SELECT hook_id AS hookId, secret FROM github_hooks WHERE repo = ?",
    repo,
  ).toArray()[0]
  if (row === undefined) throw new Error(`github_hooks has no row for ${repo} after claim`)
  return row
}

import type { HookSql } from "./hooks"

/** Run inside a storage transaction so a replay cannot close a later watch. */
export const closeWatches = (sql: HookSql, deliveryId: string, repo: string, number: number, now: number, retention: number): string[] => {
  if (sql.exec("SELECT 1 FROM pr_close_deliveries WHERE delivery_id = ?", deliveryId).toArray().length > 0) return []
  sql.exec("INSERT INTO pr_close_deliveries (delivery_id, received_at) VALUES (?, ?)", deliveryId, now)
  sql.exec("DELETE FROM pr_close_deliveries WHERE received_at < ?", now - retention)
  const owners = sql.exec<{ login: string }>("SELECT DISTINCT login FROM pr_watches WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number).toArray().map((row) => row.login)
  sql.exec("DELETE FROM pr_activity_queue WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number)
  sql.exec("DELETE FROM pr_watches WHERE repo = ? COLLATE NOCASE AND pr_number = ?", repo, number)
  return owners
}

export const discardFailedActivity = (sql: HookSql, row: { login: string; taskId: string; repo: string; number: number; deliveryId: string }): void => {
  sql.exec(`DELETE FROM pr_watches WHERE login = ? AND task_id = ? AND repo = ? COLLATE NOCASE AND pr_number = ?
    AND EXISTS (SELECT 1 FROM pr_activity_queue WHERE login = ? AND task_id = ? AND delivery_id = ?)`, row.login, row.taskId, row.repo, row.number, row.login, row.taskId, row.deliveryId)
  sql.exec("DELETE FROM pr_activity_queue WHERE login = ? AND task_id = ? AND delivery_id = ?", row.login, row.taskId, row.deliveryId)
}

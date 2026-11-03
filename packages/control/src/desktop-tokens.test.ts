import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  DESKTOP_TOKEN_TTL_MS,
  createDesktopToken,
  deleteSessionDesktopTokens,
  desktopStreamTask,
  desktopTokenSession,
  ensureDesktopTokensTable,
} from "./desktop-tokens"
import type { FileTokenSql } from "./file-tokens"

// How these tokens authorize a request through the Hub is in file-token.test.ts; this is the module's own edges.

const NOW = 1_000_000

const newSql = () => {
  const db = new Database(":memory:")
  const sql = {
    exec: (query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.query(query).all(...bindings)
      return { toArray: () => rows as never[] }
    },
  } as unknown as FileTokenSql
  ensureDesktopTokensTable(sql)
  const count = () => db.query("SELECT COUNT(*) AS n FROM session_desktop_tokens").get() as { n: number }
  return { sql, count }
}

describe("desktopTokenSession", () => {
  test("resolves until the TTL and not at it", () => {
    const { sql } = newSql()
    const { token, expiresAt } = createDesktopToken(sql, "session-1", "task-1", NOW)
    expect(Date.parse(expiresAt)).toBe(NOW + DESKTOP_TOKEN_TTL_MS)
    expect(desktopTokenSession(sql, token, "task-1", NOW + DESKTOP_TOKEN_TTL_MS - 1)).toBe("session-1")
    expect(desktopTokenSession(sql, token, "task-1", NOW + DESKTOP_TOKEN_TTL_MS)).toBeNull()
  })

  test("resolves only for the task it was minted for", () => {
    const { sql } = newSql()
    const { token } = createDesktopToken(sql, "session-1", "task-1", NOW)
    expect(desktopTokenSession(sql, token, "task-2", NOW)).toBeNull()
    expect(desktopTokenSession(sql, "not-a-token", "task-1", NOW)).toBeNull()
  })
})

describe("createDesktopToken", () => {
  test("drops expired tokens and keeps live ones", () => {
    const { sql, count } = newSql()
    const old = createDesktopToken(sql, "session-1", "task-1", NOW)
    const live = createDesktopToken(sql, "session-1", "task-1", NOW + 1)
    createDesktopToken(sql, "session-2", "task-1", NOW + DESKTOP_TOKEN_TTL_MS)
    expect(count().n).toBe(2)
    expect(desktopTokenSession(sql, old.token, "task-1", NOW)).toBeNull()
    expect(desktopTokenSession(sql, live.token, "task-1", NOW + DESKTOP_TOKEN_TTL_MS)).toBe("session-1")
  })
})

describe("deleteSessionDesktopTokens", () => {
  test("revokes every token of that session and no other session's", () => {
    const { sql } = newSql()
    const first = createDesktopToken(sql, "session-1", "task-1", NOW)
    const second = createDesktopToken(sql, "session-1", "task-2", NOW)
    const other = createDesktopToken(sql, "session-2", "task-1", NOW)
    deleteSessionDesktopTokens(sql, "session-1")
    expect(desktopTokenSession(sql, first.token, "task-1", NOW)).toBeNull()
    expect(desktopTokenSession(sql, second.token, "task-2", NOW)).toBeNull()
    expect(desktopTokenSession(sql, other.token, "task-1", NOW)).toBe("session-2")
  })
})

describe("desktopStreamTask", () => {
  test("names the task of a desktop stream path, decoded", () => {
    expect(desktopStreamTask("/api/tasks/task-1/desktop/stream")).toBe("task-1")
    expect(desktopStreamTask("/api/tasks/a%20b/desktop/stream")).toBe("a b")
  })

  test("is null for any other path and for a malformed task id", () => {
    expect(desktopStreamTask("/api/tasks/task-1/desktop/token")).toBeNull()
    expect(desktopStreamTask("/api/tasks/task-1/desktop/stream/extra")).toBeNull()
    expect(desktopStreamTask("/api/tasks/a/b/desktop/stream")).toBeNull()
    expect(desktopStreamTask("/api/tasks/%E0%A4%A/desktop/stream")).toBeNull()
  })
})

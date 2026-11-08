import { expect, test } from "bun:test"
import { isAllowedLogin, type Env } from "./env"

test("GitHub allowlist is case-insensitive and fails closed, with an explicit local dev exception", () => {
  const env = { ALLOWED_GITHUB_LOGINS: "jarenm1, caayd " } as Env
  expect(isAllowedLogin(env, "CAAYD")).toBe(true)
  expect(isAllowedLogin(env, "other")).toBe(false)
  expect(isAllowedLogin({} as Env, "")).toBe(false)
  expect(isAllowedLogin({} as Env, "dev", true)).toBe(false)
  expect(isAllowedLogin({ DEV_SESSION_LOGIN: "dev" } as Env, "another-dev", true)).toBe(true)
})

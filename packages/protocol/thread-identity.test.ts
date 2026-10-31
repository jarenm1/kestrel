import { describe, expect, test } from "bun:test"
import type { Checkout } from "./src/index"
import { threadIdentity } from "./src/thread-identity"

const thread = (title: string, checkouts: ReadonlyArray<Checkout> = [], id = "thread-a") => ({ id, title, checkouts })
const checkout = (repo: string, extra: Partial<Checkout> = {}): Checkout => ({
  id: `checkout-${repo}`,
  repo,
  dir: "dir",
  branch: "cloudagents/x",
  baseBranch: "main",
  createdAt: "2026-10-31T00:00:00.000Z",
  ...extra,
})

describe("threadIdentity", () => {
  test.each([
    ["  fix-login screen  ", "FL"],
    ["🚀 deploy preview", "DP"],
    ["t3code", "T3"],
    ["A", "A"],
    ["修复 登录", "修登"],
    ["𐐨𐐩", "𐐀𐐁"],
    ["ßeta release", "SS"],
    [" \n -- 🚀 ", "KT"],
    ["", "KT"],
  ])("without a checkout, makes a bounded monogram from the title %j", (title, monogram) => {
    expect(threadIdentity(thread(title)).monogram).toBe(monogram)
  })

  test("normalizes compatibility characters and preserves combining marks", () => {
    expect(threadIdentity(thread("Ｆｉｘ ｌｏｇｉｎ")).monogram).toBe("FL")
    expect(threadIdentity(thread("a\u0301b\u0301")).monogram).toBe("ÁB\u0301")
  })

  test("renaming a thread without a checkout updates initials without changing its finish", () => {
    const before = threadIdentity(thread("Fix login"))
    const renamed = threadIdentity(thread("Deploy preview"))
    expect([before.monogram, renamed.monogram]).toEqual(["FL", "DP"])
    expect(renamed.tone).toBe(before.tone)
  })

  test("distributes identical titles across the eight supported finishes", () => {
    const tones = new Set(Array.from({ length: 128 }, (_, i) => threadIdentity(thread("Same title", [], `thread-${i}`)).tone))
    expect([...tones].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test.each([
    ["pingdotgg/t3code", "T3"],
    ["jarenm1/kestrel", "KE"],
    ["acme/thread-monograms", "TM"],
    ["https://gitlab.com/acme/Web_App.git", "WA"],
  ])("with a checkout, takes initials from the repository name of %j", (repo, monogram) => {
    expect(threadIdentity(thread("Unrelated title", [checkout(repo)])).monogram).toBe(monogram)
  })

  test("threads on the same first repository share an identity whatever their titles and ids", () => {
    const a = threadIdentity(thread("Fix login", [checkout("jarenm1/kestrel")], "thread-a"))
    const b = threadIdentity(thread("Ship preview", [checkout("jarenm1/kestrel"), checkout("acme/web")], "thread-b"))
    expect(b).toEqual(a)
  })

  test("uses the first checkout's icon and ignores icons of later checkouts", () => {
    const icon = { path: "public/favicon.svg", blob: "a".repeat(40) }
    expect(threadIdentity(thread("x", [checkout("acme/web", { icon })])).icon).toEqual({
      checkoutId: "checkout-acme/web",
      blob: icon.blob,
    })
    expect(threadIdentity(thread("x", [checkout("acme/web"), checkout("acme/api", { icon })])).icon).toBeNull()
  })
})

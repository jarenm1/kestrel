import { describe, expect, test } from "bun:test"
import { scriptString } from "./auth"

describe("scriptString", () => {
  test("escapes a script-close tag so it cannot break out of the inline script", () => {
    const out = scriptString("</script><script>alert(1)</script>")
    expect(out).not.toContain("</script>")
    expect(out).toContain("\\u003c")
  })

  test("escapes quotes and backslashes as a JS string literal", () => {
    const out = scriptString('a"b\\c')
    expect(out).toContain('\\"')
    expect(out).toContain("\\\\")
  })
})

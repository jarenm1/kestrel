import { describe, expect, test } from "bun:test"
import { toolDisplayName } from "./src/tool-names"

describe("toolDisplayName", () => {
  test("recognizes the same Kestrel tool across harness namespaces", () => {
    const bare = toolDisplayName("desktop_screenshot")
    expect(toolDisplayName("mcp__cloudagents__desktop_screenshot")).toBe(bare)
    expect(toolDisplayName("cloudagents.desktop_screenshot")).toBe(bare)
  })

  test("keeps external servers distinct without assigning built-in semantics", () => {
    expect(toolDisplayName("mcp__catalog__Read")).toBe("Read · Catalog")
    expect(toolDisplayName("catalog.Read")).toBe("Read · Catalog")
    expect(toolDisplayName("other.Read")).not.toBe(toolDisplayName("catalog.Read"))
    expect(toolDisplayName("catalog.Read")).not.toBe(toolDisplayName("Read"))
  })

  test.each([
    ["future_tool_name", "Future tool name"],
    ["futureToolName", "Future Tool Name"],
    ["readHTTPResponse", "Read HTTP Response"],
    ["future-tool-name", "Future tool name"],
    ["mcp__my_server__future_tool", "Future tool · My server"],
    ["cloudagents.future_tool", "Future tool"],
    ["", "Tool call"],
    ["__--", "Tool call"],
    ["constructor", "Constructor"],
    ["toString", "To String"],
  ])("humanizes unknown identifier %j", (name, expected) => {
    expect(toolDisplayName(name)).toBe(expected)
  })
})

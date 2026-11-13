import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Effect } from "effect"
import { encodePng, type RgbFrame } from "../../desktop/frames"
import { registerDesktopTools, type DesktopToolDeps } from "./desktop"

const frame: RgbFrame = { width: 4, height: 2, pixels: new Uint8Array(4 * 2 * 3).map((_, i) => i * 10) }

test("desktop_screenshot with path saves the PNG at full resolution through the sandbox and still shows it", async () => {
  const saved: [string, string, Uint8Array][] = []
  const deps = {
    desktop: {
      status: () => Effect.succeed({ state: "running", width: frame.width, height: frame.height }),
      grab: () => Effect.succeed(frame),
      cursor: () => Effect.succeed({ x: 1, y: 1 }),
      save: (taskId: string, path: string, data: Uint8Array) =>
        Effect.sync(() => {
          saved.push([taskId, path, data])
          return `/workspace/${path}`
        }),
    },
  } as unknown as DesktopToolDeps
  const server = new McpServer({ name: "test", version: "1" })
  registerDesktopTools(server, { taskId: "task", runId: "run" }, deps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: "desktop_screenshot", arguments: { path: "shots/after.png" } })
    expect(result.isError).not.toBe(true)
    expect(saved).toHaveLength(1)
    const [taskId, path, data] = saved[0]!
    expect([taskId, path]).toEqual(["task", "shots/after.png"])
    expect(Buffer.from(data).equals(encodePng(frame))).toBe(true)
    const content = result.content as { type: string; text?: string }[]
    expect(content[0]?.text).toBe("saved a 4 x 2 PNG to /workspace/shots/after.png")
    expect(content.some((block) => block.type === "image")).toBe(true)

    const both = await client.callTool({ name: "desktop_screenshot", arguments: { path: "x.png", changes: true } })
    expect(both.isError).toBe(true)
    expect(saved).toHaveLength(1)
  } finally {
    await client.close()
    await server.close()
  }
})

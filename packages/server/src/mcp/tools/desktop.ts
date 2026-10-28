import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import { type RunContext, guard, runTool, text } from "./common"

export interface DesktopToolDeps {
  readonly desktop: {
    readonly status: (taskId: string) => Effect.Effect<DesktopStatus, unknown>
    readonly screenshot: (taskId: string) => Effect.Effect<Uint8Array, unknown> // PNG
    readonly input: (taskId: string, event: DesktopInput) => Effect.Effect<void, unknown>
    readonly launch: (taskId: string, command: string) => Effect.Effect<void, unknown>
  }
}

const BUTTONS = { left: 1, middle: 2, right: 3 } as const

export const registerDesktopTools = (server: McpServer, ctx: RunContext, deps: DesktopToolDeps): void => {
  /** Converts pixel coordinates to the normalized [0,1) coordinates DesktopInput uses. */
  const normalize = (x: number, y: number): Effect.Effect<{ nx: number; ny: number }, unknown> =>
    Effect.gen(function* () {
      const status = yield* deps.desktop.status(ctx.taskId)
      if (status.width <= 0 || status.height <= 0) {
        return yield* Effect.fail(new Error("the desktop has no size; it may not be running"))
      }
      if (x < 0 || y < 0 || x >= status.width || y >= status.height) {
        return yield* Effect.fail(new Error(`(${x}, ${y}) is outside the ${status.width} x ${status.height} desktop`))
      }
      return { nx: x / status.width, ny: y / status.height }
    })

  const input = (event: DesktopInput): Effect.Effect<void, unknown> => deps.desktop.input(ctx.taskId, event)

  server.registerTool(
    "desktop_screenshot",
    {
      description:
        "Take a screenshot of the task desktop. Returns a PNG image and the desktop size as 'width x height'. " +
        "Coordinates for the other desktop_* tools are pixels within that size.",
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const status = yield* deps.desktop.status(ctx.taskId)
            const png = yield* deps.desktop.screenshot(ctx.taskId)
            const result: CallToolResult = {
              content: [
                { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
                { type: "text", text: `${status.width} x ${status.height}` },
              ],
            }
            return result
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_mouse_move",
    {
      description: "Move the mouse pointer on the task desktop to pixel (x, y), origin at top-left.",
      inputSchema: {
        x: z.number().describe("Pixel x coordinate, 0 to width-1"),
        y: z.number().describe("Pixel y coordinate, 0 to height-1"),
      },
    },
    ({ x, y }: { x: number; y: number }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const { nx, ny } = yield* normalize(x, y)
            yield* input({ _tag: "mouse.move", x: nx, y: ny })
            return text(`moved mouse to (${x}, ${y})`)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_click",
    {
      description: "Click on the task desktop at pixel (x, y). Moves the pointer there first.",
      inputSchema: {
        x: z.number().describe("Pixel x coordinate, 0 to width-1"),
        y: z.number().describe("Pixel y coordinate, 0 to height-1"),
        button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button, default left"),
        double: z.boolean().optional().describe("Double-click when true, default false"),
      },
    },
    ({ x, y, button, double }: { x: number; y: number; button?: "left" | "middle" | "right"; double?: boolean }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const buttonName = button ?? "left"
            const buttonId = BUTTONS[buttonName]
            const { nx, ny } = yield* normalize(x, y)
            yield* input({ _tag: "mouse.move", x: nx, y: ny })
            const clicks = double ? 2 : 1
            for (let i = 0; i < clicks; i++) {
              yield* input({ _tag: "mouse.button", x: nx, y: ny, button: buttonId, down: true })
              yield* input({ _tag: "mouse.button", x: nx, y: ny, button: buttonId, down: false })
            }
            return text(`${double ? "double-clicked" : "clicked"} ${buttonName} button at (${x}, ${y})`)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_type",
    {
      description: "Type text into whatever has keyboard focus on the task desktop.",
      inputSchema: {
        text: z.string().describe("Text to type"),
      },
    },
    ({ text: value }: { text: string }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            yield* input({ _tag: "text", text: value })
            return text(`typed ${value.length} characters`)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_key",
    {
      description:
        "Press and release a key or key combination on the task desktop. Uses xdotool keysym names, " +
        "e.g. 'Return', 'Escape', 'Tab', 'a', 'ctrl+s', 'alt+F4'.",
      inputSchema: {
        key: z.string().describe("xdotool keysym or combination, e.g. 'Return' or 'ctrl+s'"),
      },
    },
    ({ key }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            yield* input({ _tag: "key", key, down: true })
            yield* input({ _tag: "key", key, down: false })
            return text(`pressed ${key}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_launch",
    {
      description:
        "Launch a GUI or terminal command on the task desktop, detached, so it appears on the desktop " +
        "(e.g. 'firefox', 'xterm'). Does not wait for it to exit.",
      inputSchema: {
        command: z.string().describe("Shell command to launch on the desktop"),
      },
    },
    ({ command }) =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            yield* deps.desktop.launch(ctx.taskId, command)
            return text(`launched: ${command}`)
          }),
        ),
      ),
  )
}

import type { DesktopInput, DesktopStatus } from "@cloudagents/protocol"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult, ImageContent, TextContent } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { z } from "zod"
import type { DesktopApp, DesktopRegion } from "../../desktop"
import { changedRegions, defaultScale, encodePng, type RgbFrame, resample } from "../../desktop/frames"
import { type RunContext, guard, runTool, text, truncate } from "./common"

export interface DesktopToolDeps {
  readonly desktop: {
    /** Starts the task's desktop, or returns the one already running, once it is up. */
    readonly open: (taskId: string) => Effect.Effect<DesktopStatus, unknown>
    readonly status: (taskId: string) => Effect.Effect<DesktopStatus, unknown>
    /** The whole desktop as raw RGB24, grabbed now. */
    readonly grab: (taskId: string) => Effect.Effect<RgbFrame, unknown>
    readonly cursor: (taskId: string) => Effect.Effect<{ readonly x: number; readonly y: number }, unknown>
    readonly input: (taskId: string, event: DesktopInput) => Effect.Effect<void, unknown>
    /** Starts an app on the desktop and returns its id. */
    readonly launch: (taskId: string, command: string) => Effect.Effect<string, unknown>
    readonly processes: (taskId: string) => Effect.Effect<ReadonlyArray<DesktopApp>, unknown>
    readonly kill: (taskId: string, id: string) => Effect.Effect<DesktopApp, unknown>
  }
}

interface Settle {
  readonly screenshot?: boolean
  readonly settleMs?: number
}

const BUTTONS = { left: 1, middle: 2, right: 3 } as const
const DEFAULT_SETTLE_MS = 300
/** Wheel delta per click; the manager turns each event's delta back into clicks. */
const WHEEL_DELTA_PER_CLICK = 50
const MAX_CLICKS_PER_EVENT = 10

/** Shared by the action tools: optionally return a screenshot once the UI has had time to react. */
const settleSchema = {
  screenshot: z
    .boolean()
    .optional()
    .describe("Also return what changed on the desktop after the action, as desktop_screenshot's changes view; default false"),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(`Milliseconds to wait before that screenshot, default ${DEFAULT_SETTLE_MS}`),
}

const describeApp = (app: DesktopApp): string => {
  const status = app.running
    ? "running"
    : app.signal !== null
      ? `killed by ${app.signal}`
      : `exited with code ${app.exitCode}`
  return `${app.id}  ${status}  ${app.command}`
}

/** What the image pixels mean in desktop pixels, so the agent can turn a point in the image into a click. */
const describeScreenshot = (
  status: { readonly width: number; readonly height: number },
  pointer: { readonly x: number; readonly y: number },
  region: DesktopRegion | undefined,
  scale: number,
): string => {
  const pointerText = `pointer at (${pointer.x}, ${pointer.y}) in desktop pixels`
  if (!region && scale === 1) return `${status.width} x ${status.height} desktop; image pixels = desktop pixels; ${pointerText}.`
  const size = region
    ? `region x=${region.x} y=${region.y} ${region.width} x ${region.height}`
    : `full ${status.width} x ${status.height} desktop`
  const imageWidth = Math.round((region?.width ?? status.width) * scale)
  const imageHeight = Math.round((region?.height ?? status.height) * scale)
  const originX = region?.x ?? 0
  const originY = region?.y ?? 0
  return (
    `${size} at scale ${scale}; image is ${imageWidth} x ${imageHeight} px. ` +
    `Image pixel (px, py) = desktop (${originX} + px / ${scale}, ${originY} + py / ${scale}). ${pointerText}.`
  )
}

/** Parameters of a desktop_screenshot or a settle screenshot. */
interface Look {
  readonly region?: DesktopRegion
  readonly scale?: number
  readonly changes?: boolean
}

type Block = ImageContent | TextContent

const note = (value: string): TextContent => ({ type: "text", text: value })

/** An image of `area`, then the mapping from its pixels to desktop pixels, so a point in the image can become a click. */
const viewBlocks = (
  frame: RgbFrame,
  area: DesktopRegion,
  scale: number,
  pointer: { readonly x: number; readonly y: number },
  region: DesktopRegion | undefined,
): Block[] => [
  { type: "image", data: encodePng(resample(frame, area, scale)).toString("base64"), mimeType: "image/png" },
  { type: "text", text: describeScreenshot(frame, pointer, region, scale) },
]

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

  /** Desktop tools act on a running desktop; otherwise they fail and say how to get one. */
  const runDesktopTool = (effect: Effect.Effect<CallToolResult, unknown>): Promise<CallToolResult> =>
    runTool(
      Effect.flatMap(deps.desktop.status(ctx.taskId), (status) =>
        status.state === "running" ? effect : Effect.fail(new Error(`the desktop is ${status.state}; call desktop_open first`)),
      ),
    )

  let previous: RgbFrame | null = null

  /** Captures the desktop or a region as blocks. With `changes`, only the parts that differ from this session's previous capture. */
  const look = (request: Look): Effect.Effect<Block[], unknown> =>
    Effect.gen(function* () {
      const status = yield* deps.desktop.status(ctx.taskId)
      const region = request.region
      if (region && (region.x + region.width > status.width || region.y + region.height > status.height)) {
        return yield* Effect.fail(new Error(`region is outside the ${status.width} x ${status.height} desktop`))
      }
      const frame = yield* deps.desktop.grab(ctx.taskId)
      const baseline = previous
      previous = frame
      const pointer = yield* deps.desktop.cursor(ctx.taskId)
      const area = region ?? { x: 0, y: 0, width: frame.width, height: frame.height }
      const fullScale = request.scale ?? defaultScale(area)
      if (!request.changes) return viewBlocks(frame, area, fullScale, pointer, region)
      if (baseline === null) {
        return [note("no earlier screenshot in this session; full view"), ...viewBlocks(frame, area, fullScale, pointer, region)]
      }
      const boxes = changedRegions(baseline, frame, area)
      if (boxes.length === 0) return [note("no change since the previous screenshot")]
      const changedPixels = boxes.reduce((sum, box) => sum + box.width * box.height, 0)
      if (changedPixels * 2 > area.width * area.height) {
        return [
          note("most of the area changed since the previous screenshot; full view"),
          ...viewBlocks(frame, area, fullScale, pointer, region),
        ]
      }
      const boxScale = request.scale ?? 1
      return [
        note(`${boxes.length} changed region(s) since the previous screenshot`),
        ...boxes.flatMap((box) => viewBlocks(frame, box, boxScale, pointer, box)),
      ]
    })

  /** An action's summary, plus what changed on the desktop after the settle delay when the caller asked for a screenshot. */
  const finish = (summary: string, settle: Settle): Effect.Effect<CallToolResult, unknown> =>
    Effect.gen(function* () {
      if (!settle.screenshot) return text(summary)
      yield* Effect.sleep(settle.settleMs ?? DEFAULT_SETTLE_MS)
      const content = yield* look({ changes: true })
      const result: CallToolResult = { content: [{ type: "text", text: summary }, ...content] }
      return result
    })

  server.registerTool(
    "desktop_open",
    {
      description:
        "Start the task's desktop (a virtual screen with a terminal) and wait until it is running. The desktop tools " +
        "need a running desktop, so call this before them. If the desktop is already running, this returns it. The user " +
        "can watch it in the Desktop tab.",
    },
    () =>
      guard(() =>
        runTool(
          Effect.gen(function* () {
            const status = yield* deps.desktop.open(ctx.taskId)
            return text(`desktop is running at ${status.width} x ${status.height}`)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_screenshot",
    {
      description:
        "Take a screenshot of the task desktop as a PNG. Optional region crops to a rectangle; scale resizes it (default " +
        "fits the long edge within 1280 px). With changes, returns only the parts that changed since this session's " +
        "previous screenshot, each at full resolution. The result states how image pixels map to desktop pixels. Pixel " +
        "coordinates for the other desktop_* tools are desktop pixels, origin at top-left.",
      inputSchema: {
        region: z
          .object({
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          })
          .optional()
          .describe("Crop to this rectangle of the desktop, in desktop pixels"),
        scale: z
          .number()
          .min(0.1)
          .max(4)
          .optional()
          .describe("Resize the image by this factor; default fits 1280 px, or 1 with changes"),
        changes: z
          .boolean()
          .optional()
          .describe(
            "Return only what changed since the previous screenshot, as full-resolution crops; the full view when there is " +
              "none or most of the area changed. Default false",
          ),
      },
    },
    ({ region, scale, changes }: Look) =>
      guard(() => runDesktopTool(look({ region, scale, changes }).pipe(Effect.map((content): CallToolResult => ({ content }))))),
  )

  server.registerTool(
    "desktop_cursor_position",
    {
      description: "Report where the mouse pointer is on the task desktop, in desktop pixels.",
    },
    () =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const pointer = yield* deps.desktop.cursor(ctx.taskId)
            return text(`pointer at (${pointer.x}, ${pointer.y})`)
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
        ...settleSchema,
      },
    },
    ({ x, y, ...settle }: { x: number; y: number } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const { nx, ny } = yield* normalize(x, y)
            yield* input({ _tag: "mouse.move", x: nx, y: ny })
            return yield* finish(`moved mouse to (${x}, ${y})`, settle)
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
        ...settleSchema,
      },
    },
    ({
      x,
      y,
      button,
      double,
      ...settle
    }: { x: number; y: number; button?: keyof typeof BUTTONS; double?: boolean } & Settle) =>
      guard(() =>
        runDesktopTool(
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
            return yield* finish(
              `${double ? "double-clicked" : "clicked"} ${buttonName} button at (${x}, ${y})`,
              settle,
            )
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_drag",
    {
      description:
        "Press a mouse button at (fromX, fromY), move to (toX, toY) in steps, and release there. " +
        "Use it to select text, move windows, or drag items.",
      inputSchema: {
        fromX: z.number().describe("Pixel x where the drag starts"),
        fromY: z.number().describe("Pixel y where the drag starts"),
        toX: z.number().describe("Pixel x where the drag ends"),
        toY: z.number().describe("Pixel y where the drag ends"),
        button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button, default left"),
        steps: z.number().int().min(1).max(100).optional().describe("Pointer moves between the two points, default 10"),
        ...settleSchema,
      },
    },
    ({
      fromX,
      fromY,
      toX,
      toY,
      button,
      steps,
      ...settle
    }: {
      fromX: number
      fromY: number
      toX: number
      toY: number
      button?: keyof typeof BUTTONS
      steps?: number
    } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const buttonName = button ?? "left"
            const buttonId = BUTTONS[buttonName]
            const count = steps ?? 10
            const from = yield* normalize(fromX, fromY)
            const to = yield* normalize(toX, toY)
            yield* input({ _tag: "mouse.move", x: from.nx, y: from.ny })
            yield* input({ _tag: "mouse.button", x: from.nx, y: from.ny, button: buttonId, down: true })
            for (let i = 1; i <= count; i++) {
              const t = i / count
              yield* input({
                _tag: "mouse.move",
                x: from.nx + (to.nx - from.nx) * t,
                y: from.ny + (to.ny - from.ny) * t,
              })
            }
            yield* input({ _tag: "mouse.button", x: to.nx, y: to.ny, button: buttonId, down: false })
            return yield* finish(
              `dragged ${buttonName} button from (${fromX}, ${fromY}) to (${toX}, ${toY})`,
              settle,
            )
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_scroll",
    {
      description:
        "Scroll the mouse wheel on the task desktop at pixel (x, y). Moves the pointer there, then scrolls " +
        "amount clicks (default 3). 'down' moves the view down the page.",
      inputSchema: {
        x: z.number().describe("Pixel x coordinate, 0 to width-1"),
        y: z.number().describe("Pixel y coordinate, 0 to height-1"),
        direction: z.enum(["up", "down", "left", "right"]).describe("Direction to scroll"),
        amount: z.number().int().min(1).max(50).optional().describe("Wheel clicks, default 3"),
        ...settleSchema,
      },
    },
    ({
      x,
      y,
      direction,
      amount,
      ...settle
    }: {
      x: number
      y: number
      direction: "up" | "down" | "left" | "right"
      amount?: number
    } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const clicks = amount ?? 3
            const { nx, ny } = yield* normalize(x, y)
            yield* input({ _tag: "mouse.move", x: nx, y: ny })
            const vertical = direction === "up" || direction === "down"
            const sign = direction === "down" || direction === "right" ? 1 : -1
            for (let left = clicks; left > 0; left -= MAX_CLICKS_PER_EVENT) {
              const delta = sign * WHEEL_DELTA_PER_CLICK * Math.min(left, MAX_CLICKS_PER_EVENT)
              yield* input({ _tag: "mouse.wheel", dx: vertical ? 0 : delta, dy: vertical ? delta : 0 })
            }
            return yield* finish(`scrolled ${direction} ${clicks} clicks at (${x}, ${y})`, settle)
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
        ...settleSchema,
      },
    },
    ({ text: value, ...settle }: { text: string } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            yield* input({ _tag: "text", text: value })
            return yield* finish(`typed ${value.length} characters`, settle)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_key",
    {
      description:
        "Press and release a key or key combination on the task desktop. Uses xdotool keysym names, " +
        "e.g. 'Return', 'Escape', 'Tab', 'a', 'ctrl+s', 'alt+F4', '+' for the plus key. " +
        "repeat presses it several times; holdMs keeps each press down that long.",
      inputSchema: {
        key: z.string().describe("xdotool keysym or combination, e.g. 'Return' or 'ctrl+s'"),
        repeat: z.number().int().min(1).max(100).optional().describe("How many times to press it, default 1"),
        holdMs: z.number().int().min(0).max(5000).optional().describe("Milliseconds to hold each press, default 0"),
        ...settleSchema,
      },
    },
    ({
      key,
      repeat,
      holdMs,
      ...settle
    }: { key: string; repeat?: number; holdMs?: number } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const presses = repeat ?? 1
            for (let i = 0; i < presses; i++) {
              yield* input({ _tag: "key", key, down: true })
              if (holdMs && holdMs > 0) yield* Effect.sleep(holdMs)
              yield* input({ _tag: "key", key, down: false })
            }
            return yield* finish(`pressed ${key}${presses > 1 ? ` ${presses} times` : ""}`, settle)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_launch",
    {
      description:
        "Start a GUI or terminal command on the task desktop, detached, so it appears on the desktop " +
        "(e.g. 'firefox', 'xterm'). Returns an app id for desktop_processes and desktop_kill. " +
        "Does not wait for it to exit.",
      inputSchema: {
        command: z.string().describe("Shell command to launch on the desktop"),
        ...settleSchema,
      },
    },
    ({ command, ...settle }: { command: string } & Settle) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const id = yield* deps.desktop.launch(ctx.taskId, command)
            return yield* finish(`launched ${id}: ${command}`, settle)
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_processes",
    {
      description:
        "List the apps started with desktop_launch on the task desktop, exited ones included, with the last " +
        "lines of each one's output (stdout and stderr, bounded per app).",
      inputSchema: {
        lines: z.number().int().min(0).max(200).optional().describe("Output lines to show per app, default 20"),
      },
    },
    ({ lines }: { lines?: number }) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const apps = yield* deps.desktop.processes(ctx.taskId)
            if (apps.length === 0) return text("no apps launched on the desktop")
            const shown = lines ?? 20
            const blocks = apps.map((app) => {
              const tail =
                app.output === "" || shown === 0 ? [] : app.output.replace(/\n$/, "").split("\n").slice(-shown)
              return [describeApp(app), ...tail.map((line) => `  ${line}`)].join("\n")
            })
            return text(truncate(blocks.join("\n\n")))
          }),
        ),
      ),
  )

  server.registerTool(
    "desktop_kill",
    {
      description:
        "Stop an app started with desktop_launch: SIGTERM, then SIGKILL after a short grace period. " +
        "Returns the app's final state.",
      inputSchema: {
        id: z.string().describe("App id from desktop_launch, e.g. 'app-1'"),
      },
    },
    ({ id }: { id: string }) =>
      guard(() =>
        runDesktopTool(
          Effect.gen(function* () {
            const app = yield* deps.desktop.kill(ctx.taskId, id)
            return text(describeApp(app))
          }),
        ),
      ),
  )
}

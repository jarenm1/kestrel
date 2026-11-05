import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Effect } from "effect"
import type { GpuOnDemand } from "../../platform/service"
import { guard, runTool, text, type RunContext } from "./common"

export interface GpuToolDeps {
  /** Null on a box that cannot borrow a GPU; the tools are not offered then. */
  readonly gpu: GpuOnDemand | null
}

export const registerGpuTools = (server: McpServer, ctx: RunContext, deps: GpuToolDeps): void => {
  const gpu = deps.gpu
  if (gpu === null) return
  server.registerTool(
    "gpu_request",
    {
      description:
        "Borrow the box's GPU for GPU work (rendering, machine learning, video encoding). The host attaches it within " +
        "about two minutes, and the desktop then renders on it; until then rendering is software-only. Call gpu_release " +
        "when the GPU work is done so the host can take the GPU back.",
    },
    () => guard(() => runTool(Effect.map(gpu.request(ctx.runId), () => text("GPU attached")))),
  )
  server.registerTool(
    "gpu_release",
    {
      description:
        "Stop asking for the box's GPU. The host detaches it once nothing else wants it, and the desktop returns to " +
        "software rendering.",
    },
    () => guard(() => runTool(Effect.map(gpu.release(ctx.runId), () => text("GPU released")))),
  )
}

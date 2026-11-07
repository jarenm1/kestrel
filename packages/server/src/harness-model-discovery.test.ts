import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiscoveryLaunch } from "./harness-commands"
import { modelUpstreamId } from "@cloudagents/protocol"
import {
  discoverAcpModels,
  discoverClaudeModels,
  discoverCodexModels,
  discoverOpenCodeModels,
  parseAcpModels,
  parseClaudeModels,
  parseCodexModelPage,
  parseOpenCodeModels,
  toModelInfos,
} from "./harness-model-discovery"
import { platformEnv } from "./process"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** A launch for a fake CLI run by the test runner itself; it never uses the test's directory as a working directory. */
const launchFor = (source: string): DiscoveryLaunch => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-model-discovery-"))
  roots.push(root)
  const file = join(root, "cli.mjs")
  writeFileSync(file, source)
  return { file: process.execPath, args: [file], env: platformEnv(), cwd: process.cwd() }
}

describe("parseClaudeModels", () => {
  test("prefers the concrete resolvedModel over an alias and drops malformed rows", () => {
    expect(
      parseClaudeModels([
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "sonnet", resolvedModel: "" },
        { value: "", resolvedModel: null },
        null,
        "not a model",
      ]),
    ).toEqual(["claude-opus-5-5", "claude-opus-5-5", "sonnet"])
    expect(parseClaudeModels(undefined)).toEqual([])
    expect(parseClaudeModels({ models: [] })).toEqual([])
  })
})

describe("parseCodexModelPage", () => {
  test("keeps visible models, prefers model over id, and reads the cursor", () => {
    expect(
      parseCodexModelPage({
        data: [
          { id: "catalog-row-1", model: "gpt-6.1-sol", hidden: false },
          { id: "hidden", model: "hidden", hidden: true },
          { id: "gpt-6.1-terra" },
          { id: "", model: "" },
          null,
        ],
        nextCursor: "2",
      }),
    ).toEqual({ upstreams: ["gpt-6.1-sol", "gpt-6.1-terra"], nextCursor: "2" })
    expect(parseCodexModelPage({ data: "nope", nextCursor: 3 })).toEqual({ upstreams: [], nextCursor: null })
  })
})

describe("parseAcpModels", () => {
  test("reads the model select option flat or grouped and ignores other options", () => {
    expect(
      parseAcpModels({
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: "gemini-3.8-flash",
            options: [
              { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
              { group: "other", name: "Other", options: [{ value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }] },
            ],
          },
          { id: "thought_level", category: "thought_level", type: "select", options: [{ value: "high" }] },
          { id: "model", category: "model", type: "boolean" },
        ],
      }),
    ).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"])
  })

})

describe("parseOpenCodeModels", () => {
  test("keeps provider-qualified rows only, stripped of ANSI and decoration", () => {
    expect(
      parseOpenCodeModels(
        "\x1b[1mProvider models\x1b[0m\n\n  opencode/big-pickle  Big Pickle\nopencode-go/kimi-k3.1-pro\nnot-a-model\n",
      ),
    ).toEqual(["opencode/big-pickle", "opencode-go/kimi-k3.1-pro"])
  })
})

describe("toModelInfos", () => {
  test("keeps curated metadata and dedupes a known model named twice", () => {
    const models = toModelInfos("anthropic", ["claude-opus-5-5", "claude-opus-5-5"])
    expect(models.map((model) => model.id)).toEqual(["claude-opus-5-5"])
    expect(models[0]?.name).toBe("Claude Opus 5.5")
    expect(models[0]?.efforts).not.toEqual([])
  })

  test("adds an unknown model as a bounded native live id with no speculative metadata", () => {
    expect(toModelInfos("openai", ["gpt-unreleased-9"])).toEqual([
      {
        id: "live/openai/gpt-unreleased-9",
        provider: "openai",
        name: "GPT Unreleased 9",
        efforts: [],
        shownByDefault: true,
        upstreamModel: "gpt-unreleased-9",
      },
    ])
  })

  test("drops ids that cannot be a model name and another provider's OpenCode models", () => {
    expect(toModelInfos("openai", ["bad model", "with@sign", "x".repeat(201), "gpt-6.1-sol"])).toEqual(
      toModelInfos("openai", ["gpt-6.1-sol"]),
    )
    expect(
      toModelInfos("opencode", [
        "anthropic/claude-sonnet-5-5",
        "opencode/gpt-6.1-sol",
        "opencode/big-pickle",
        "opencode/glm-5.3-flash-free",
      ]).map((model) => model.id),
    ).toEqual(["opencode/big-pickle", "opencode/glm-5.3-flash-free"])
    expect(
      toModelInfos("opencode-go", [
        "opencode/big-pickle",
        "opencode-go/glm-5.3",
        "opencode-go/beam-free",
        "opencode-go/muse-spark-1.3-contributor",
        "opencode-go/claude-next",
        "opencode-go/gpt-9",
        "opencode-go/o10",
        "opencode-go/gemini-next",
      ]).map((model) => model.id),
    ).toEqual(["opencode-go/glm-5.3"])
  })

  test("strips the Claude Code 1m decoration so the id stays a model id", () => {
    expect(toModelInfos("anthropic", ["claude-opus-4-8[1m]"]).map((model) => model.id)).toEqual(["claude-opus-4-8"])
  })
})


/** A fake app-server that answers initialize then pages two model lists, with one hidden model. */
const FAKE_CODEX = `
let buffer = ""
let page = 0
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  const lines = buffer.split("\\n")
  buffer = lines.pop()
  for (const line of lines) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex" } })
    } else if (message.method === "model/list") {
      page++
      if (page === 1) {
        send({
          id: message.id,
          result: {
            data: [
              { id: "gpt-6.1-sol", model: "gpt-6.1-sol", hidden: false },
              { id: "gpt-hidden", model: "gpt-hidden", hidden: true },
            ],
            nextCursor: "1",
          },
        })
      } else {
        send({ id: message.id, result: { data: [{ id: "gpt-new-live", model: "gpt-new-live" }], nextCursor: null } })
      }
    }
  }
})
`

describe("discoverCodexModels", () => {
  test("follows pagination, filters hidden models and maps known ids to curated metadata", async () => {
    const found = await discoverCodexModels(launchFor(FAKE_CODEX))
    expect(found.status).toBe("ok")
    expect(found.models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "live/openai/gpt-new-live"])
    expect(found.models[0]?.name).toBe("GPT-6.1 Sol")
  })

  test("reports an older CLI without model/list as unsupported", async () => {
    const found = await discoverCodexModels(
      launchFor(`
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
    else if (message.method === "model/list") {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "method not found" } }) + "\\n")
    }
  }
})
`),
    )
    expect(found).toEqual({ models: [], status: "unsupported", message: "this Codex version does not list models" })
  })

  test("fails with a safe message when the server refuses model/list", async () => {
    await expect(
      discoverCodexModels(
        launchFor(`
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
    else if (message.method === "model/list") {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: "/secret/path refused" } }) + "\\n")
    }
  }
})
`),
      ),
    ).rejects.toThrow("codex model discovery could not list models")
  })

  test("fails safe when the CLI prints more than the discovery bound", async () => {
    await expect(
      discoverCodexModels(
        launchFor(`
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
    else if (message.method === "model/list") process.stdout.write("x".repeat(3 * 1024 * 1024) + "\\n")
  }
})
`),
      ),
    ).rejects.toThrow("printed too much")
  })
})

describe("discoverOpenCodeModels", () => {
  test("keeps this login's provider rows from the CLI's plain model list", async () => {
    const found = await discoverOpenCodeModels(
      "opencode",
      launchFor(
        `process.stdout.write("anthropic/claude-sonnet-5-5\\nopencode/gpt-6.1-sol\\nopencode/big-pickle\\nopencode/new-free\\n")`,
      ),
    )
    expect(found.status).toBe("ok")
    expect(found.models.map((model) => modelUpstreamId(model.id))).toEqual(["opencode/big-pickle", "opencode/new-free"])
  })

  test("fails safe when the CLI prints more than the discovery bound", async () => {
    await expect(
      discoverOpenCodeModels("opencode", launchFor(`process.stdout.write("x".repeat(3 * 1024 * 1024))`)),
    ).rejects.toThrow("printed too much")
  })
})

describe("discoverClaudeModels", () => {
  test("returns the initialize models with no prompt or turn", async () => {
    const found = await discoverClaudeModels(
      launchFor(`
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.type !== "control_request") continue
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            models: [
              { value: "default", resolvedModel: "claude-opus-5-5" },
              { value: "opus", resolvedModel: "claude-opus-5-5" },
              { value: "fable", resolvedModel: "claude-fable-5-1" },
            ],
          },
        },
      }) + "\\n",
    )
  }
})
`),
    )
    expect(found.status).toBe("ok")
    expect(found.models.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1"])
  })

  test("is unsupported when an older CLI's initialize response has no models", async () => {
    const found = await discoverClaudeModels(
      launchFor(`
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id, response: {} },
      }) + "\\n",
    )
  }
})
`),
    )
    expect(found).toEqual({ models: [], status: "unsupported", message: "the CLI reported no available models" })
  })
})

/** A fake ACP agent that opens one session and never prompts. */
const FAKE_ACP = (sessionResult: string) => `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
    else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: ${sessionResult} })
    else if (message.method === "session/prompt") process.exit(9)
  }
})
`

describe("discoverAcpModels", () => {
  test("reads a session's model config option", async () => {
    const found = await discoverAcpModels(
      "google",
      launchFor(
        FAKE_ACP(
          `{ sessionId: "s-1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "gemini-3.8-flash", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-9-preview", name: "Preview" }] }] }`,
        ),
      ),
    )
    expect(found.status).toBe("ok")
    expect(found.models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "live/google/gemini-9-preview"])
  })

  test("is unsupported for a session that offers no model list", async () => {
    const found = await discoverAcpModels("devin", launchFor(FAKE_ACP(`{ sessionId: "s-1" }`)))
    expect(found).toEqual({ models: [], status: "unsupported", message: "the CLI reported no available models" })
  })

  test("reports a required sign-in as unsupported, not a failure", async () => {
    const found = await discoverAcpModels(
      "google",
      launchFor(`
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.trim() === "") continue
    const message = JSON.parse(line)
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
    else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "auth_required" } })
  }
})
`),
    )
    expect(found).toEqual({ models: [], status: "unsupported", message: "sign-in required" })
  })
})

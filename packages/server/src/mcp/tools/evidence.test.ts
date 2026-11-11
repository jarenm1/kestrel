import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Effect } from "effect"
import { type EvidenceToolDeps, registerEvidenceTools } from "./evidence"

/** Connects the evidence tools to an in-memory client; `calls` records what each core operation received. */
const connect = async (evidence: Partial<EvidenceToolDeps["evidence"]>) => {
  const server = new McpServer({ name: "test", version: "1" })
  registerEvidenceTools(server, { taskId: "task", runId: "run" }, { evidence } as unknown as EvidenceToolDeps)
  const client = new Client({ name: "test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

test("evidence_attach_to_pr defaults runId to the session's run and reports the comment and evidence URLs", async () => {
  const calls: unknown[] = []
  const { client, close } = await connect({
    attach: (taskId, input) =>
      Effect.sync(() => {
        calls.push([taskId, input])
        return {
          commentUrl: "https://github.com/acme/widget/pull/7#issuecomment-1",
          evidenceUrl: "https://github.com/user-attachments/assets/clip",
        }
      }),
  })
  try {
    const result = await client.callTool({ name: "evidence_attach_to_pr", arguments: { caption: "Spawn works", checkout: "c2" } })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain(
      "Attached the clip (https://github.com/user-attachments/assets/clip) to the thread's pull request: https://github.com/acme/widget/pull/7#issuecomment-1",
    )
    expect(calls).toEqual([
      ["task", { caption: "Spawn works", checkoutId: "c2", runId: "run", clipId: undefined, poster: undefined }],
    ])

    const poster = await client.callTool({
      name: "evidence_attach_to_pr",
      arguments: { caption: "The frame", runId: "other", clipId: "clip", poster: true },
    })
    expect(poster.isError).not.toBe(true)
    expect(JSON.stringify(poster)).toContain("Attached the poster image")
    expect(calls[1]).toEqual([
      "task",
      { caption: "The frame", checkoutId: undefined, runId: "other", clipId: "clip", poster: true },
    ])
  } finally {
    await close()
  }
})

test("evidence_attach_to_pr reports a core failure as a tool error, including the open-pull-request and size limits", async () => {
  let calls = 0
  const { client, close } = await connect({
    attach: () =>
      Effect.suspend(() => {
        calls += 1
        return Effect.fail(new Error("pull request #7 is closed; evidence attaches only to an open pull request"))
      }),
  })
  try {
    const result = await client.callTool({ name: "evidence_attach_to_pr", arguments: { caption: "Spawn works", checkout: "c2" } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain("evidence attaches only to an open pull request")
    expect(calls).toBe(1)
  } finally {
    await close()
  }
})

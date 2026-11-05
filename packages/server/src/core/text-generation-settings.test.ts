import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_TEXT_GENERATION_SETTINGS, TextGenerationSettings } from "@cloudagents/protocol"
import { readTextGenerationSettings, writeTextGenerationSettings } from "./text-generation-settings"

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "kestrel-text-settings-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test("persists a user's choices without exposing them to another user or box", async () => {
  const chosen: TextGenerationSettings = {
    enabled: false,
    model: "claude-opus-5",
    effort: "low",
    threadTitleInstructions: "Use sentence case and name the affected subsystem.",
    responseStreamingMode: "turn",
  }
  await Effect.runPromise(writeTextGenerationSettings(root, "alice", chosen))
  expect(await Effect.runPromise(readTextGenerationSettings(root, "alice"))).toEqual(chosen)
  expect(await Effect.runPromise(readTextGenerationSettings(root, "bob"))).toEqual(DEFAULT_TEXT_GENERATION_SETTINGS)
  expect(await Effect.runPromise(readTextGenerationSettings(join(root, "other-box"), "alice"))).toEqual(DEFAULT_TEXT_GENERATION_SETTINGS)
})

test("existing saved preferences retain their choices when the toggle is introduced", async () => {
  const chosen: TextGenerationSettings = {
    ...DEFAULT_TEXT_GENERATION_SETTINGS,
    model: "claude-opus-5",
    effort: "medium",
    threadTitleInstructions: "Name the affected subsystem.",
    responseStreamingMode: "turn",
  }
  await Effect.runPromise(writeTextGenerationSettings(root, "alice", chosen))
  const [name] = await readdir(join(root, "text-generation"))
  const file = join(root, "text-generation", name!)
  const legacy = JSON.parse(await readFile(file, "utf8"))
  delete legacy.enabled
  await writeFile(file, JSON.stringify(legacy))
  expect(await Effect.runPromise(readTextGenerationSettings(root, "alice"))).toEqual(chosen)
})

test("corrupt saved settings fail instead of silently resetting user choices", async () => {
  await Effect.runPromise(writeTextGenerationSettings(root, "alice", DEFAULT_TEXT_GENERATION_SETTINGS))
  const [file] = await readdir(join(root, "text-generation"))
  await writeFile(join(root, "text-generation", file!), '{"model":"removed-model"}')
  const result = await Effect.runPromise(Effect.either(readTextGenerationSettings(root, "alice")))
  expect(result._tag).toBe("Left")
  if (result._tag === "Left") expect(result.left.message).toBe("invalid saved text generation settings")
})

test("refuses a thinking level unsupported by the explicitly selected model", () => {
  expect(Schema.decodeUnknownEither(TextGenerationSettings)({
    ...DEFAULT_TEXT_GENERATION_SETTINGS, model: "claude-opus-5", effort: "none",
  })._tag).toBe("Left")
})

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_ATTACHMENT_BYTES } from "@cloudagents/protocol"
import { runImageFile, saveRunImage } from "./run-images"

const runDir = mkdtempSync(join(tmpdir(), "run-images-"))
afterAll(() => rmSync(runDir, { recursive: true, force: true }))

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")

describe("run images", () => {
  test("a saved image is served back byte for byte, under an id that names its content", () => {
    const saved = saveRunImage(runDir, PNG.toString("base64"), "image/png")
    expect(saved?.mimeType).toBe("image/png")
    expect(saved?.id).toMatch(/^[0-9a-f]{32}\.png$/)
    // The same bytes again are the same image.
    expect(saveRunImage(runDir, PNG.toString("base64"), "image/png")).toEqual(saved!)
    const file = runImageFile(runDir, saved!.id)
    expect(file?.mimeType).toBe("image/png")
    expect(readFileSync(file!.path)).toEqual(PNG)
  })

  test("types the app cannot show, non-base64 data and oversized images are not kept", () => {
    expect(saveRunImage(runDir, PNG.toString("base64"), "image/svg+xml")).toBeNull()
    expect(saveRunImage(runDir, "not base64!", "image/png")).toBeNull()
    expect(saveRunImage(runDir, "", "image/png")).toBeNull()
    expect(saveRunImage(runDir, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"), "image/png")).toBeNull()
  })

  test("an id that saveRunImage would not make names no file", () => {
    for (const id of ["../items.json", "..%2Fitems.json", "0123456789abcdef0123456789abcdef.svg", "x.png", "0123456789abcdef0123456789abcdef.png/.."]) {
      expect(runImageFile(runDir, id)).toBeNull()
    }
  })
})

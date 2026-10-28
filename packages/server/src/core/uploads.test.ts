import { describe, expect, test } from "bun:test"
import { agentText, attachmentPath, sanitizeUploadName } from "./uploads"

const home = "/home/agent"

describe("sanitizeUploadName", () => {
  test("keeps only the base name", () => {
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd")
    expect(sanitizeUploadName("C:\\photos\\cat.png")).toBe("cat.png")
  })

  test("refuses names with nothing usable", () => {
    expect(sanitizeUploadName(undefined)).toBeUndefined()
    expect(sanitizeUploadName("   ")).toBeUndefined()
    expect(sanitizeUploadName("..")).toBeUndefined()
  })
})

describe("attachmentPath", () => {
  test("uses the user's name when there is one", () => {
    expect(attachmentPath(home, { id: "u1", mimeType: "image/png", name: "cat.png" })).toBe("/home/agent/uploads/u1/cat.png")
  })

  test("falls back to the id and a type extension", () => {
    expect(attachmentPath(home, { id: "u2", mimeType: "image/jpeg" })).toBe("/home/agent/uploads/u2/u2.jpg")
  })
})

describe("agentText", () => {
  test("is the text unchanged without attachments", () => {
    expect(agentText("hi", [], home)).toBe("hi")
  })

  test("names each file by its agent path after the text", () => {
    const cat = { id: "u1", mimeType: "image/png", name: "cat.png" }
    expect(agentText("look", [cat], home)).toBe(
      "look\n\nThe user attached 1 file(s):\n- /home/agent/uploads/u1/cat.png (image/png)\nOpen them with your file-reading tool (images are viewable).",
    )
  })

  test("is the note alone when the text is blank", () => {
    const cat = { id: "u1", mimeType: "image/png", name: "cat.png" }
    expect(agentText("  ", [cat], home)).toBe(
      "The user attached 1 file(s):\n- /home/agent/uploads/u1/cat.png (image/png)\nOpen them with your file-reading tool (images are viewable).",
    )
  })
})

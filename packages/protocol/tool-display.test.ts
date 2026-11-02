import { describe, expect, test } from "bun:test"
import { describeTool, displayCommand, displayToolPath, editDiff, outputText, summarizeTools, type ToolItem } from "./src/tool-display"

const TASK = "t_123"
const tool = (name: string, input: unknown, status: ToolItem["status"] = "ok"): ToolItem => ({
  _tag: "tool",
  id: `${name}-${JSON.stringify(input)}`,
  parentToolId: null,
  name,
  input,
  status,
  output: null,
})

describe("displayCommand", () => {
  test("a sandbox shell wrapper with a store path reduces to the script", () => {
    expect(
      displayCommand(
        `/nix/store/pf46qwvvla688cz33gd4n1xcmrf2fasq-cloudagents-sandbox-env/bin/bash -lc 'sed -i "s/BLENDER_EEVEE_NEXT/BLENDER_EEVEE/" /tmp/make_icecream_cat.py && blender -b -t 4 --python /tmp/make_icecream_cat.py'`,
      ),
    ).toBe(`sed -i "s/BLENDER_EEVEE_NEXT/BLENDER_EEVEE/" /tmp/make_icecream_cat.py && blender -b -t 4 --python /tmp/make_icecream_cat.py`)
  })

  test("double-quoted scripts unescape, and store paths inside the script go too", () => {
    expect(displayCommand(`/bin/bash -lc "echo \\"hi\\" && /nix/store/0123456789abcdfghijklmnpqrsvwxyz-python3-3.12/bin/python3 x.py"`)).toBe(
      `echo "hi" && python3 x.py`,
    )
    expect(displayCommand(`sh -c 'ls -la'`)).toBe("ls -la")
  })

  test("wrappers that are not a lone script stay whole", () => {
    // Positional arguments after the script change what it does.
    expect(displayCommand(`bash -c 'echo $1' _ hi`)).toBe(`bash -c 'echo $1' _ hi`)
    // A compound outer command is not one shell invocation.
    expect(displayCommand(`bash -lc 'make' && echo done`)).toBe(`bash -lc 'make' && echo done`)
    expect(displayCommand(`bash script.sh`)).toBe("bash script.sh")
    expect(displayCommand(`bash -lc 'unterminated`)).toBe(`bash -lc 'unterminated`)
  })
})

describe("displayToolPath", () => {
  test("workspace paths become relative, the agent's home becomes ~", () => {
    expect(displayToolPath(`/var/lib/kestrel/threads/${TASK}/repo/src/a.ts`, TASK)).toBe("repo/src/a.ts")
    expect(displayToolPath(`/var/lib/kestrel/threads/${TASK}`, TASK)).toBe(".")
    expect(displayToolPath("/home/agent/.config/x.json", TASK)).toBe("~/.config/x.json")
    // Another thread's directory is not this workspace.
    expect(displayToolPath(`/var/lib/kestrel/threads/${TASK}0/a.ts`, TASK)).toBe(`/var/lib/kestrel/threads/${TASK}0/a.ts`)
    expect(displayToolPath("/tmp/out.png", TASK)).toBe("/tmp/out.png")
    expect(displayToolPath(`C:\\data\\threads\\${TASK}\\repo\\a.ts`, TASK)).toBe("repo/a.ts")
  })
})

describe("describeTool", () => {
  test("commands from every harness read the same, with workspace paths made relative", () => {
    const command = `/nix/store/pf46qwvvla688cz33gd4n1xcmrf2fasq-cloudagents-sandbox-env/bin/bash -lc 'cat /data/threads/${TASK}/notes.md'`
    for (const name of ["command_execution", "Bash", "mcp__cloudagents__workspace_exec", "cloudagents.workspace_exec"]) {
      expect(describeTool(tool(name, { command }), TASK)).toMatchObject({ kind: "command", label: "cat ./notes.md", code: true })
    }
  })

  test("edits count changed lines, not the whole replaced block", () => {
    const view = describeTool(
      tool("Edit", { file_path: `/d/threads/${TASK}/a.ts`, old_string: "one\ntwo\nthree", new_string: "one\n2\nthree\nfour" }),
      TASK,
    )
    expect(view).toMatchObject({ kind: "edit", label: "Edited a.ts", added: 2, removed: 1 })
  })

  test("desktop actions say what happened where", () => {
    expect(describeTool(tool("mcp__cloudagents__desktop_click", { x: 300, y: 200, double: true }), TASK).label).toBe("Double-clicked (300, 200)")
    expect(describeTool(tool("cloudagents.desktop_key", { key: "ctrl+l", repeat: 3 }), TASK).label).toBe("Pressed ctrl+l ×3")
    expect(describeTool(tool("mcp__cloudagents__desktop_type", { text: "echo hi" }), TASK).label).toBe("Typed “echo hi”")
    expect(describeTool(tool("mcp__cloudagents__desktop_screenshot", { region: { x: 0, y: 0, width: 640, height: 400 } }), TASK).label).toBe(
      "Took a screenshot of 640×400 at (0, 0)",
    )
  })

  test("an external server's tool keeps its server name instead of borrowing a built-in's meaning", () => {
    expect(describeTool(tool("mcp__linear__Read", { file_path: "/x" }), TASK)).toMatchObject({ kind: "other", label: "Read · Linear" })
  })
})

describe("editDiff", () => {
  test("keeps common lines as context", () => {
    expect(editDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ])
  })
})

describe("summarizeTools", () => {
  test("kinds in order of first use, edits by distinct file, long lists cut short", () => {
    const views = [
      tool("Bash", { command: "ls" }),
      tool("Read", { file_path: "/a" }),
      tool("Edit", { file_path: "/a", old_string: "x", new_string: "y" }),
      tool("Bash", { command: "make" }),
      tool("Edit", { file_path: "/a", old_string: "y", new_string: "z" }),
    ].map((item) => describeTool(item, TASK))
    expect(summarizeTools(views)).toBe("Ran 2 commands, read 1 file, edited 1 file")
    const more = [...views, describeTool(tool("Grep", { pattern: "x" }), TASK)]
    expect(summarizeTools(more)).toBe("Ran 2 commands, read 1 file, edited 1 file, ran 1 search")
    const most = [...more, describeTool(tool("WebSearch", { query: "x" }), TASK)]
    expect(summarizeTools(most)).toBe("Ran 2 commands, read 1 file, edited 1 file, +2 more")
  })
})

describe("outputText", () => {
  test("a command that prints [image] keeps its output exactly, whitespace included", () => {
    expect(outputText("  [image]\n[image]\n\n", "command")).toEqual({ text: "  [image]\n[image]\n\n", images: 0 })
  })

  test("a desktop tool's image placeholders become a count and its text stays as returned", () => {
    expect(outputText("clicked (412, 88)\n[image]", "desktop")).toEqual({ text: "clicked (412, 88)", images: 1 })
  })
})

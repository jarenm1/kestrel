import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { probeQmp, qmpCommand } from "./qmp"
import { makeTempDir, type TempDir } from "./test-support"

let tmp: TempDir
let sock: string
let server: Server

/** In-process QMP server: greeting, one asynchronous event before each reply, and scripted replies. */
const startServer = async (): Promise<void> => {
  server = createServer((socket) => {
    socket.write('{"QMP":{"version":{},"capabilities":[]}}\r\n')
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)) as { execute: string; arguments?: unknown }
        buffer = buffer.slice(newline + 1)
        socket.write('{"event":"NOISE","data":{}}\r\n')
        if (request.execute === "qmp_capabilities") socket.write('{"return":{}}\r\n')
        else if (request.execute === "fail")
          socket.write('{"error":{"class":"GenericError","desc":"nope"}}\r\n')
        else socket.write(`${JSON.stringify({ return: { echo: request.arguments ?? null } })}\r\n`)
        newline = buffer.indexOf("\n")
      }
    })
    socket.on("error", () => {})
  })
  const ready = Promise.withResolvers<void>()
  server.listen(sock, () => ready.resolve())
  await ready.promise
}

beforeEach(async () => {
  tmp = makeTempDir("qmp")
  sock = join(tmp.path, "qmp.sock")
  await startServer()
})

afterEach(() => {
  server.close()
  tmp.dispose()
})

describe("QMP client", () => {
  test("probeQmp succeeds against a live greeting and fails on a missing socket", async () => {
    expect(await probeQmp(sock, 2000)).toBe(true)
    expect(await probeQmp(join(tmp.path, "missing.sock"), 300)).toBe(false)
  })

  test("qmpCommand negotiates, runs the command, and skips asynchronous events", async () => {
    expect(await qmpCommand(sock, "query-status", 2000)).toEqual({ echo: null })
    expect(await qmpCommand(sock, "query-status", 2000, { x: 1 })).toEqual({ echo: { x: 1 } })
  })

  test("a QMP error reply rejects with the error description", async () => {
    await expect(qmpCommand(sock, "fail", 2000)).rejects.toThrow(/nope/)
  })
})

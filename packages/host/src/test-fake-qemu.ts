// Test double for the QEMU process started by the launcher. Serves QMP on a unix socket and exits
// after system_powerdown or quit. Argv: <vm name> <qmp socket path>.
// FAKE_QEMU_MODE=ignore-powerdown answers system_powerdown but keeps running.
// FAKE_QEMU_MODE=exit-immediately prints a line to stdout and exits 1 before serving QMP.
import { createServer, type Socket } from "node:net"
import { existsSync, unlinkSync } from "node:fs"

const [, , , sock] = process.argv
const mode = process.env.FAKE_QEMU_MODE ?? ""

if (!sock) {
  console.error("usage: test-fake-qemu <name> <qmp-socket>")
  process.exit(2)
}

if (mode === "exit-immediately") {
  console.log("fake qemu: boom")
  process.exit(1)
}

if (existsSync(sock)) unlinkSync(sock)

const exitSoon = (): void => {
  setTimeout(() => process.exit(0), 100)
}

const reply = (socket: Socket, message: unknown): void => {
  socket.write(`${JSON.stringify(message)}\r\n`)
}

const handle = (socket: Socket, line: string): void => {
  const request = JSON.parse(line) as { execute?: string }
  switch (request.execute) {
    case "qmp_capabilities":
      reply(socket, { return: {} })
      return
    case "system_powerdown":
      reply(socket, { return: {} })
      if (mode !== "ignore-powerdown") exitSoon()
      return
    case "quit":
      reply(socket, { return: {} })
      exitSoon()
      return
    default:
      reply(socket, { error: { class: "CommandNotFound", desc: `unknown command ${request.execute}` } })
  }
}

const server = createServer((socket) => {
  reply(socket, { QMP: { version: { qemu: { major: 9, minor: 0, micro: 0 } }, capabilities: [] } })
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) handle(socket, line)
      newline = buffer.indexOf("\n")
    }
  })
  socket.on("error", () => {})
})

server.listen(sock)

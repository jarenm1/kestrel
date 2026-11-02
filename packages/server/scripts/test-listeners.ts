/**
 * Run the real box with a local control stub and a deterministic agent, using isolated data and ephemeral ports.
 * No model keys or real control plane are used. Requires Bun; basic and strict also require bwrap on PATH.
 * strict also needs pasta, nsenter and unshare on PATH, /dev/net/tun, and the sandbox toolchain
 * (CLOUDAGENTS_SANDBOX_PATH, set by `nix develop`).
 *   bun packages/server/scripts/test-listeners.ts off
 *   bun packages/server/scripts/test-listeners.ts basic [--managed]
 *   bun packages/server/scripts/test-listeners.ts strict [--managed]   (inside `nix develop`)
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BOX_ID_HEADER, BOX_TOKEN_QUERY, signBoxToken } from "@cloudagents/protocol"

const sandbox = process.argv[2] ?? "off"
assert(["off", "basic", "strict"].includes(sandbox), "sandbox must be off, basic or strict")
const sandboxPath = process.env.CLOUDAGENTS_SANDBOX_PATH
assert(sandbox !== "strict" || sandboxPath, "strict needs CLOUDAGENTS_SANDBOX_PATH; run inside `nix develop`")
const managed = process.argv.includes("--managed")
const owner = "listener-test"
const boxId = "listener-test-box"
const secret = crypto.randomUUID()
const root = resolve(import.meta.dir, "../../..")
const dataDir = await mkdtemp(join(tmpdir(), "kestrel-listeners-"))
const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert(address !== null && typeof address === "object")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
const publicPort = await freePort()
let privatePort = await freePort()
while (privatePort === publicPort) privatePort = await freePort()
const base = `http://127.0.0.1:${publicPort}`
const privateBase = `http://127.0.0.1:${privatePort}`
let lookups = 0
const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const expected = managed ? "/box/credentials" : "/box/self"
    if (request.method !== "GET" || new URL(request.url).pathname !== expected) return new Response(null, { status: 404 })
    if (request.headers.get("authorization") !== `Bearer ${secret}` || request.headers.get(BOX_ID_HEADER) !== boxId) {
      return new Response(null, { status: 401 })
    }
    if (managed && request.headers.get("x-kestrel-box-user") !== owner) return new Response(null, { status: 403 })
    lookups++
    return Response.json({ owner, credentialsVersion: "0:" })
  },
})
const child = Bun.spawn([process.execPath, "packages/server/src/main.ts"], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLOUDAGENTS_HOST: "127.0.0.1",
    CLOUDAGENTS_PORT: String(publicPort),
    CLOUDAGENTS_SANDBOX_PORT: String(privatePort),
    CLOUDAGENTS_DATA_DIR: dataDir,
    CLOUDAGENTS_SANDBOX: sandbox,
    ...(sandbox === "strict" ? { CLOUDAGENTS_SANDBOX_PATH: sandboxPath, CLOUDAGENTS_SANDBOX_SSL: process.env.CLOUDAGENTS_SANDBOX_SSL } : {}),
    CLOUDAGENTS_SYSTEMD: "0",
    CLOUDAGENTS_FAKE_AGENT: "1",
    CLOUDAGENTS_CONTROL_URL: `http://127.0.0.1:${control.port}`,
    CLOUDAGENTS_BOX_ID: boxId,
    CLOUDAGENTS_BOX_SECRET: secret,
    CLOUDAGENTS_BOX_MANAGED: managed ? "1" : "0",
  },
  stdout: "pipe",
  stderr: "pipe",
})
const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
let socket: WebSocket | undefined
let passed = false
const checkStatus = async (url: string, status: number, headers?: HeadersInit) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  await response.arrayBuffer()
  assert.equal(response.status, status, `expected HTTP ${status} at ${new URL(url).pathname.replace(/\/broker\/[^/]+/, "/broker/<token>")}`)
}
try {
  let healthy = false
  for (let attempt = 0; attempt < 100; attempt++) {
    healthy = await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)
    if (healthy || child.exitCode !== null) break
    await Bun.sleep(100)
  }
  assert(healthy, "box did not start")
  await checkStatus(`${base}/mcp/test`, 404)
  await checkStatus(`${base}/broker/test/anthropic/v1/models`, 404)
  await checkStatus(`${privateBase}/api/health`, 404)
  await checkStatus(`${privateBase}/mcp/test`, 401)
  await checkStatus(`${privateBase}/broker/test/anthropic/v1/models`, 401)
  await checkStatus(`${base}/api/tasks`, 401, { authorization: "Bearer invalid" })
  console.log("PASS: public/private routes and unauthenticated requests")

  const now = Math.floor(Date.now() / 1000)
  const token = await signBoxToken(secret, { sub: owner, aud: boxId, iat: now, exp: now + 300, cv: "0:" })
  const headers = { authorization: `Bearer ${token}`, [BOX_ID_HEADER]: boxId, "content-type": "application/json" }
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    assert(response.ok, `${path}: HTTP ${response.status}: ${await response.clone().text()}`)
    return response.json()
  }
  socket = new WebSocket(`${base.replace("http:", "ws:")}/api/events?${BOX_TOKEN_QUERY}=${encodeURIComponent(token)}`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("event WebSocket did not open")), 5000)
    socket!.onopen = () => { clearTimeout(timer); resolve() }
    socket!.onerror = () => { clearTimeout(timer); reject(new Error("event WebSocket failed")) }
  })
  const task = await api("/api/tasks", {}) as { id: string }
  const sent = await api(`/api/tasks/${task.id}/messages`, { text: `listener-probe ${publicPort} ${control.port} ${sandbox === "strict" ? "unreachable" : "unchecked"}`, model: "claude-sonnet-4-6" }) as { run: { id: string } }
  let run: { id: string; status: string } | undefined
  for (let attempt = 0; attempt < 150; attempt++) {
    const runs = await api(`/api/tasks/${task.id}/runs`) as Array<{ id: string; status: string }>
    run = runs.find(r => r.id === sent.run.id)
    if (run !== undefined && run.status !== "running" && run.status !== "queued") break
    await Bun.sleep(100)
  }
  if (run?.status !== "succeeded") {
    // Agent output helps diagnose missing bwrap/toolchain without printing any per-run credential files.
    console.error(JSON.stringify(await api(`/api/runs/${sent.run.id}/items`)))
  }
  assert.equal(run?.status, "succeeded", "authenticated agent run failed")
  assert.equal(lookups, 1, "one credentials lookup for this session")
  console.log(`PASS: authenticated ${managed ? "managed" : "BYOB"} API/WebSocket, ${sandbox} agent MCP, broker, workspace exec${sandbox === "strict" ? " and loopback isolation" : ""}`)

  const mcp = JSON.parse(await readFile(join(dataDir, "homes", task.id, ".cloudagents", "mcp.json"), "utf8"))
    .mcpServers.cloudagents as { url: string; headers: { Authorization: string } }
  assert.equal(new URL(mcp.url).port, String(privatePort), "agent must use the private listener")
  const runToken = mcp.headers.Authorization.slice("Bearer ".length)
  await checkStatus(mcp.url, 401, mcp.headers)
  await checkStatus(`${privateBase}/broker/${runToken}/anthropic/v1/models`, 401)
  // A valid box token is also insufficient for sandbox tools on either listener.
  await checkStatus(`${privateBase}/mcp/${task.id}`, 401, headers)
  await checkStatus(`${base}/mcp/${task.id}`, 404, headers)
  console.log("PASS: completed-run credentials revoked; box token cannot access MCP")
  passed = true
} finally {
  socket?.close()
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  await child.exited
  clearTimeout(timer)
  const output = await logs
  if (!passed) console.error(output.join("\n"))
  control.stop(true)
  await rm(dataDir, { recursive: true, force: true })
}

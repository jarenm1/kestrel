// Plain TCP relay for the WAN bench. The worker container reaches the stacks through this proxy, bound to the bridge
// gateway (172.31.0.1). Plain TCP, so WebSocket upgrades pass through unchanged.
// Usage: bun proxy.ts --listen 172.31.0.1:8868 --to 127.0.0.1:8868

interface Link {
	peer: Bun.Socket<Link> | null
	queued: Buffer[]
	// Bun's write() keeps the unsent tail of a chunk. end() drops that tail, so half-close waits for drain.
	buffered: boolean
	finishing: boolean
	closed: boolean
}

// Accepts `host:port` and bracketed IPv6 `[addr]:port` (the baseline app listens on [::1]).
function hostPort(value: string): { hostname: string; port: number } {
	const m = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:\[\]]+):(\d+)$/.exec(value)
	if (!m) throw new Error(`bad host:port ${value}`)
	return { hostname: m[1]!, port: Number(m[2]) }
}

function flag(name: string): string {
	const i = Bun.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Bun.argv[i + 1] : undefined
	if (!v) throw new Error(`missing --${name}`)
	return v
}

const listen = hostPort(flag("listen"))
const target = hostPort(flag("to"))

// Copies the chunk (Bun may reuse the read buffer) and records whether Bun kept an unsent tail.
function send(to: Bun.Socket<Link>, chunk: Buffer) {
	const copy = Buffer.from(chunk)
	const n = to.write(copy)
	if (n < copy.length) to.data.buffered = true
}

// Half-close `sock` once everything written to it has been flushed.
function finish(sock: Bun.Socket<Link> | null | undefined) {
	if (!sock) return
	if (sock.data.buffered) sock.data.finishing = true
	else sock.end()
}

function onDrain(sock: Bun.Socket<Link>) {
	sock.data.buffered = false
	if (sock.data.finishing) {
		sock.data.finishing = false
		sock.end()
	}
}

Bun.listen<Link>({
	hostname: listen.hostname,
	port: listen.port,
	socket: {
		open(client) {
			client.data = { peer: null, queued: [], buffered: false, finishing: false, closed: false }
			Bun.connect<Link>({
				hostname: target.hostname,
				port: target.port,
				socket: {
					open(up) {
						up.data = { peer: client, queued: [], buffered: false, finishing: false, closed: false }
						if (client.data.closed) {
							up.end()
							return
						}
						client.data.peer = up
						for (const chunk of client.data.queued) send(up, chunk)
						client.data.queued = []
					},
					data(up, chunk) {
						if (up.data.peer) send(up.data.peer, chunk)
					},
					drain: onDrain,
					close(up) {
						finish(up.data?.peer ?? client)
					},
					error(up) {
						finish(up.data?.peer ?? client)
					},
				},
			})
		},
		data(client, chunk) {
			if (client.data.peer) send(client.data.peer, chunk)
			else client.data.queued.push(Buffer.from(chunk))
		},
		drain: onDrain,
		close(client) {
			client.data.closed = true
			finish(client.data.peer)
		},
		error(client) {
			client.data.closed = true
			finish(client.data.peer)
		},
	},
})

console.error(`proxy ${listen.hostname}:${listen.port} -> ${target.hostname}:${target.port}`)

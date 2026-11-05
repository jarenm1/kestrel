#!/usr/bin/env bun
// Desktop benchmark driver: one transport under one network condition. See README.md.
//
// Drives a real browser (Chrome over CDP) against a running Kestrel stack and measures:
//   1. glass-to-glass keypress latency (keydown in page → pixels change in the viewer surface)
//   2. application bytes on the wire per minute, idle / typing / scrolling
//   3. box-side CPU (box process, ffmpeg, xdamage-capture, other desktop children) from /proc
//   4. control-plane request estimate: WebSocket messages the browser sent/received + /api HTTP requests
//
// Usage: bun bench.ts --transport ws|webrtc --label <name> --api <url> --page <url> --cdp-port <n> --box-cwd <dir> --out <file> [options]

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Cdp } from "./cdp"
import { INIT_JS, PROBE_JS } from "./probe"

interface Options {
	transport: "ws" | "webrtc"
	label: string
	/** Control-plane URL reachable from the machine running this script (API calls). */
	api: string
	/** Control-plane URL as the browser sees it (page loads, WebSocket). */
	page: string
	cdpPort: number
	/** Command prefix that runs a shell where the box lives (e.g. `docker exec <name>`); empty = local. */
	boxExec: string[]
	/** Working directory of the box process; identifies the box among other processes on the host. */
	boxCwd: string
	samples: number
	workloadSec: number
	/** JS expression that focuses the keyboard target and returns true when focused. */
	focus: string
	out: string
}

interface KeySpec {
	key: string
	code: string
	vk: number
	text: string
}

interface Counters {
	wsRxBytes: number
	wsTxBytes: number
	wsRxFrames: number
	wsTxFrames: number
	desktopWsRxBytes: number
	desktopWsTxBytes: number
	apiRequests: number
}

interface RtcCounters {
	rx: number
	tx: number
	videoRx: number
	audioRx: number
	videoFrames: number
	audioPackets: number
	freezeCount: number
	freezeMs: number
	apiRx: number
	apiTx: number
	dcRx: number
	dcTx: number
	keyFrames: number
	pli: number
	fir: number
	nack: number
}

interface Snapshot {
	at: number
	c: Counters
	rtc: RtcCounters
	frames: { decoded: number; drawn: number; freezes: number; freezeMs: number }
}

interface WindowStats {
	seconds: number
	wsRxBytes: number
	wsTxBytes: number
	wsRxFrames: number
	wsTxFrames: number
	desktopWsRxBytes: number
	desktopWsTxBytes: number
	rtcRxBytes: number
	rtcTxBytes: number
	videoRxBytes: number
	audioRxBytes: number
	audioPackets: number
	framesDecoded: number
	framesRendered: number
	freezes: number
	freezeMs: number
	fps: { decoded: number; rendered: number }
	apiRequests: number
	/** Estimate of Durable Object billable requests: WS messages in both directions + /api HTTP requests. */
	doRequestEstimate: number
	bytesPerMinute: { wsRx: number; wsTx: number; rtcRx: number; rtcTx: number; videoRx: number; audioRx: number; apiRx: number; apiTx: number; total: number; totalWithApi: number }
	/** Window RTC breakdown: data-channel and residual bytes per minute; keyframe and feedback counts for the window. */
	breakdown: { dataChannelRx: number; dataChannelTx: number; otherRx: number; otherTx: number; keyFrames: number; pli: number; fir: number; nack: number }
	cpuCores: Record<string, number>
}

const KEY_W: KeySpec = { key: "W", code: "KeyW", vk: 87, text: "W" }
const KEY_BS: KeySpec = { key: "Backspace", code: "Backspace", vk: 8, text: "" }
const KEY_ENTER: KeySpec = { key: "Enter", code: "Enter", vk: 13, text: "\r" }
const TYPING_TEXT = "the quick brown fox jumps over the lazy dog "
const RECT_JS = `(() => { const s = document.querySelector('video') || document.querySelector('canvas[tabindex="0"]') || document.querySelector('canvas'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
const STAT_SCRIPT = "cat /proc/[0-9]*/stat 2>/dev/null"
const ROOT_SCRIPT =
	'for p in /proc/[0-9]*; do [ "$(readlink $p/cwd 2>/dev/null)" = "$1" ] || continue; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in *src/main.ts*) echo "${p#/proc/}";; esac; done'

const startedMs = Date.now()

function log(msg: string): void {
	console.error(`[bench +${Math.round((Date.now() - startedMs) / 1000)}s] ${msg}`)
}

function fail(msg: string): never {
	throw new Error(msg)
}

/** Writes the viewer canvas as PNG for visual checks (branch video surfaces are skipped). */
async function saveShot(c: Cdp, file: string): Promise<void> {
	const url = await c.evaluate<string>(`(() => { const s = __kb.surface(); return s && s.tagName === "CANVAS" ? s.toDataURL("image/png") : "" })()`)
	if (url) writeFileSync(file, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"))
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>()
	setTimeout(resolve, ms)
	return promise
}

function round(v: number): number {
	return Number.isFinite(v) ? Math.round(v * 10) / 10 : v
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN
	const rank = Math.ceil((p / 100) * sorted.length)
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN
}

function parseArgs(argv: string[]): Options {
	const flags = new Map<string, string>()
	for (let i = 0; i < argv.length; i += 2) {
		const k = argv[i]
		const v = argv[i + 1]
		if (!k?.startsWith("--") || v === undefined) fail(`bad argument near ${k}`)
		flags.set(k.slice(2), v)
	}
	const need = (k: string): string => flags.get(k) ?? fail(`missing --${k}`)
	const transport = need("transport")
	if (transport !== "ws" && transport !== "webrtc") fail("--transport must be ws or webrtc")
	const focusDefault =
		transport === "ws"
			? `(() => { const c = document.querySelector('canvas[tabindex="0"]'); if (!c) return false; c.focus(); return document.activeElement === c; })()`
			: "false"
	const boxExec = (flags.get("box-exec") ?? "").trim()
	return {
		transport,
		label: need("label"),
		api: need("api").replace(/\/$/, ""),
		page: need("page").replace(/\/$/, ""),
		cdpPort: Number(need("cdp-port")),
		boxExec: boxExec ? boxExec.split(/\s+/) : [],
		boxCwd: need("box-cwd"),
		samples: Number(flags.get("samples") ?? "200"),
		workloadSec: Number(flags.get("workload-sec") ?? "30"),
		focus: flags.get("focus") ?? focusDefault,
		out: need("out"),
	}
}

// ---------------------------------------------------------------- control plane (API calls from this host)

async function login(api: string): Promise<string> {
	const res = await fetch(`${api}/auth/dev-login`, { redirect: "manual" })
	const cookie = res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ")
	if (!cookie) fail(`dev-login returned ${res.status} without a cookie`)
	return cookie
}

async function api<T>(base: string, cookie: string, method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	if (!res.ok) fail(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
	return (text ? JSON.parse(text) : {}) as T
}

// ---------------------------------------------------------------- box process sampling

interface StatRow {
	pid: number
	ppid: number
	comm: string
	ticks: number
}

async function shell(prefix: string[], script: string, args: string[] = []): Promise<string> {
	const proc = Bun.spawn([...prefix, "sh", "-c", script, "sh", ...args], { stdout: "pipe", stderr: "pipe" })
	const out = await new Response(proc.stdout).text()
	await proc.exited
	return out
}

function parseStat(text: string): StatRow[] {
	const rows: StatRow[] = []
	for (const line of text.split("\n")) {
		const open = line.indexOf("(")
		const close = line.lastIndexOf(")")
		if (open < 0 || close < 0) continue
		const pid = Number(line.slice(0, open).trim())
		const rest = line
			.slice(close + 2)
			.trim()
			.split(/\s+/)
		// rest[0]=state, rest[1]=ppid, rest[11]=utime, rest[12]=stime (fields 14, 15 of /proc/<pid>/stat)
		const ppid = Number(rest[1])
		const ticks = Number(rest[11]) + Number(rest[12])
		if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(ticks)) {
			rows.push({ pid, ppid, comm: line.slice(open + 1, close), ticks })
		}
	}
	return rows
}

/** Samples CPU ticks of the box root and its descendants once per second, grouped by role. */
class BoxSampler {
	private prev = new Map<number, number>()
	readonly ticks = new Map<string, number>()
	private running = false
	private loop: Promise<void> = Promise.resolve()
	private firstAt = 0
	private lastAt = 0
	/** Wall seconds from the first to the last sample: the denominator for CPU (ticks are deltas between samples). */
	get seconds(): number {
		return (this.lastAt - this.firstAt) / 1000
	}

	constructor(
		private readonly prefix: string[],
		private readonly rootPid: number,
	) {}

	private async tick(): Promise<void> {
		const rows = parseStat(await shell(this.prefix, STAT_SCRIPT))
		const now = Date.now()
		if (this.firstAt === 0) this.firstAt = now
		this.lastAt = now
		const byPid = new Map(rows.map((r) => [r.pid, r]))
		const inTree = new Set<number>([this.rootPid])
		for (let grew = true; grew; ) {
			grew = false
			for (const r of rows) {
				if (!inTree.has(r.pid) && inTree.has(r.ppid)) {
					inTree.add(r.pid)
					grew = true
				}
			}
		}
		for (const pid of inTree) {
			const row = byPid.get(pid)
			if (!row) continue
			const before = this.prev.get(pid)
			if (before !== undefined) {
				const group = pid === this.rootPid ? "box" : row.comm === "ffmpeg" ? "ffmpeg" : row.comm === "xdamage-capture" ? "xdamage" : "other-desktop"
				this.ticks.set(group, (this.ticks.get(group) ?? 0) + Math.max(0, row.ticks - before))
			}
			this.prev.set(pid, row.ticks)
		}
	}

	start(): void {
		this.running = true
		this.loop = (async () => {
			while (this.running) {
				await this.tick()
				await sleep(1000)
			}
		})()
	}

	async stop(): Promise<void> {
		this.running = false
		await this.loop
		await this.tick()
	}
}

// ---------------------------------------------------------------- helpers

function frameBytes(opcode: number, payload: string): number {
	if (opcode === 2) {
		const pad = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
		return Math.floor((payload.length * 3) / 4) - pad
	}
	return new TextEncoder().encode(payload).length
}

async function waitFor(c: Cdp, expr: string, timeoutMs: number, what: string): Promise<void> {
	const end = Date.now() + timeoutMs
	while (Date.now() < end) {
		if (await c.evaluate<boolean>(`(${expr})`)) return
		await sleep(250)
	}
	fail(`timed out waiting for ${what}`)
}

async function tapKey(c: Cdp, k: KeySpec): Promise<void> {
	await c.send("Input.dispatchKeyEvent", {
		type: k.text ? "keyDown" : "rawKeyDown",
		key: k.key,
		code: k.code,
		windowsVirtualKeyCode: k.vk,
		text: k.text || undefined,
	})
	await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk })
	await sleep(30)
}

async function typeLine(c: Cdp, text: string): Promise<void> {
	for (const ch of text) {
		await tapKey(c, { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch })
	}
	await tapKey(c, { key: "Enter", code: "Enter", vk: 13, text: "\r" })
}

async function snapshot(c: Cdp, counters: Counters): Promise<Snapshot> {
	const { rtc, frames } = await c.evaluate<{ rtc: RtcCounters; frames: Snapshot["frames"] }>(
		`(async () => ({ rtc: await __kb.rtcBytes(), frames: { decoded: window.__frames.decoded, drawn: window.__frames.drawn, freezes: window.__frames.freezes, freezeMs: window.__frames.freezeMs } }))()`,
	)
	return { at: Date.now(), c: { ...counters }, rtc, frames }
}

async function measure(
	c: Cdp,
	opt: Options,
	counters: Counters,
	rootPid: number,
	name: string,
	drive: () => Promise<void>,
): Promise<WindowStats> {
	// Gaps measured from before the window (e.g. idle time) must not count as freezes.
	await c.evaluate(`window.__frames && (window.__frames.last = null)`)
	const before = await snapshot(c, counters)
	const sampler = new BoxSampler(opt.boxExec, rootPid)
	sampler.start()
	await drive()
	await sampler.stop()
	const after = await snapshot(c, counters)
	const seconds = (after.at - before.at) / 1000
	const d = (k: keyof Counters): number => after.c[k] - before.c[k]
	const dRtc = (k: keyof RtcCounters): number => after.rtc[k] - before.rtc[k]
	const rtcRx = dRtc("rx")
	const rtcTx = dRtc("tx")
	const perMin = (v: number): number => round((v / seconds) * 60)
	const cpuCores: Record<string, number> = {}
	for (const [g, t] of sampler.ticks) cpuCores[g] = Math.round((t / 100 / sampler.seconds) * 1000) / 1000
	// WS: decoded = VideoDecoder output, rendered = canvas drawImage of a VideoFrame. WebRTC: inbound-rtp framesDecoded
	// (the <video> presents every decoded frame, so rendered = decoded).
	const framesDecoded = after.frames.decoded - before.frames.decoded + dRtc("videoFrames")
	const framesRendered = opt.transport === "webrtc" ? dRtc("videoFrames") : after.frames.drawn - before.frames.drawn
	const freezes = opt.transport === "webrtc" ? dRtc("freezeCount") : after.frames.freezes - before.frames.freezes
	const freezeMs = round(opt.transport === "webrtc" ? dRtc("freezeMs") : after.frames.freezeMs - before.frames.freezeMs)
	const stats: WindowStats = {
		seconds: round(seconds),
		wsRxBytes: d("wsRxBytes"),
		wsTxBytes: d("wsTxBytes"),
		wsRxFrames: d("wsRxFrames"),
		wsTxFrames: d("wsTxFrames"),
		desktopWsRxBytes: d("desktopWsRxBytes"),
		desktopWsTxBytes: d("desktopWsTxBytes"),
		rtcRxBytes: rtcRx,
		rtcTxBytes: rtcTx,
		videoRxBytes: dRtc("videoRx"),
		audioRxBytes: dRtc("audioRx"),
		audioPackets: dRtc("audioPackets"),
		framesDecoded,
		framesRendered,
		freezes,
		freezeMs,
		fps: { decoded: round(framesDecoded / seconds), rendered: round(framesRendered / seconds) },
		apiRequests: d("apiRequests"),
		doRequestEstimate: d("wsRxFrames") + d("wsTxFrames") + d("apiRequests"),
		bytesPerMinute: {
			wsRx: perMin(d("wsRxBytes")),
			wsTx: perMin(d("wsTxBytes")),
			rtcRx: perMin(rtcRx),
			rtcTx: perMin(rtcTx),
			videoRx: perMin(dRtc("videoRx")),
			audioRx: perMin(dRtc("audioRx")),
			total: perMin(opt.transport === "webrtc" ? rtcRx + rtcTx : d("desktopWsRxBytes") + d("desktopWsTxBytes")),
			apiRx: perMin(dRtc("apiRx")),
			apiTx: perMin(dRtc("apiTx")),
			totalWithApi: perMin(d("wsRxBytes") + d("wsTxBytes") + rtcRx + rtcTx + dRtc("apiRx") + dRtc("apiTx")),
		},
		breakdown: {
			dataChannelRx: perMin(dRtc("dcRx")),
			dataChannelTx: perMin(dRtc("dcTx")),
			/** Media-PC receive bytes that are neither RTP video/audio nor data-channel payload: RTCP, SCTP/DTLS, ICE. */
			otherRx: perMin(rtcRx - dRtc("videoRx") - dRtc("audioRx") - dRtc("dcRx")),
			otherTx: perMin(rtcTx - dRtc("dcTx")),
			keyFrames: dRtc("keyFrames"),
			pli: dRtc("pli"),
			fir: dRtc("fir"),
			nack: dRtc("nack"),
		},
		cpuCores,
	}
	console.error(`[${name}] ${JSON.stringify(stats.bytesPerMinute)} fps=${JSON.stringify(stats.fps)} cpu=${JSON.stringify(cpuCores)}`)
	return stats
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
	const opt = parseArgs(Bun.argv.slice(2))
	const cookie = await login(opt.api)
	const task = await api<{ id: string }>(opt.api, cookie, "POST", "/api/tasks", {
		title: `bench-${opt.transport}-${opt.label}`,
	})
	const taskId = task.id
	log(`task ${taskId}`)
	const result: Record<string, unknown> = {
		transport: opt.transport,
		label: opt.label,
		taskId,
		startedAt: new Date().toISOString(),
		samplesRequested: opt.samples,
		workloadSec: opt.workloadSec,
	}
	const counters: Counters = {
		wsRxBytes: 0,
		wsTxBytes: 0,
		wsRxFrames: 0,
		wsTxFrames: 0,
		desktopWsRxBytes: 0,
		desktopWsTxBytes: 0,
		apiRequests: 0,
	}
	const wsUrls = new Map<string, string>()
	let cdp: Cdp | undefined
	try {
		await api(opt.api, cookie, "POST", `/api/tasks/${taskId}/desktop`)
		for (let i = 0; ; i++) {
			const d = await api<{ state: string; error: string | null }>(opt.api, cookie, "GET", `/api/tasks/${taskId}/desktop`)
			if (d.state === "running") break
			if (d.state === "error" || i > 120) fail(`desktop did not start: ${JSON.stringify(d)}`)
			await sleep(1000)
		}

		log("desktop running")
		const c = await Cdp.newPage(opt.cdpPort)
		cdp = c
		c.on("Network.webSocketCreated", (p) => {
			const { requestId, url } = p as { requestId: string; url: string }
			wsUrls.set(requestId, url)
		})
		const onFrame = (dir: "rx" | "tx") => (p: unknown) => {
			const { requestId, response } = p as { requestId: string; response: { opcode: number; payloadData: string } }
			if (response.opcode !== 1 && response.opcode !== 2) return
			const bytes = frameBytes(response.opcode, response.payloadData)
			const isDesktop = (wsUrls.get(requestId) ?? "").includes("/desktop")
			if (dir === "rx") {
				counters.wsRxBytes += bytes
				counters.wsRxFrames++
				if (isDesktop) counters.desktopWsRxBytes += bytes
			} else {
				counters.wsTxBytes += bytes
				counters.wsTxFrames++
				if (isDesktop) counters.desktopWsTxBytes += bytes
			}
		}
		c.on("Network.webSocketFrameReceived", onFrame("rx"))
		c.on("Network.webSocketFrameSent", onFrame("tx"))
		c.on("Network.requestWillBeSent", (p) => {
			const { request } = p as { request: { url: string } }
			if (request.url.includes("/api/")) counters.apiRequests++
		})
		await c.send("Network.enable")
		await c.send("Page.enable")
		await c.send("Page.bringToFront")
		await c.send("Runtime.enable")
		await c.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
		await c.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_JS })

		await c.send("Page.navigate", { url: `${opt.page}/auth/dev-login` })
		await sleep(2000)
		await c.send("Page.navigate", { url: `${opt.page}/c/${taskId}` })
		await sleep(3000)
		const opened = await c.evaluate<boolean>(
			`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^desktop$/i.test(x.getAttribute('aria-label') || x.title || '')); if (!b) return false; b.click(); return true; })()`,
		)
		if (!opened) fail("Desktop tab button not found")
		log("desktop tab opened")
		await waitFor(c, `!!(document.querySelector('video') || document.querySelector('canvas'))`, 60_000, "viewer surface")
		await sleep(4000)
		const focused = await c.evaluate<boolean>(`(${opt.focus})`)
		if (!focused) fail("could not focus the keyboard target (check --focus)")
		log("viewer focused")
		await c.evaluate<boolean>(PROBE_JS)

		// ---- 1. keypress latency. Shared detector with local://latency-probe.md: bright pixels (r+g+b>450) in
		// x130..370, y57..107; change of >=15 px vs. the count at key time; timestamp = rAF frame time.
		// Alternate W / BackSpace with 300-450 ms gaps so every sample is one visible state change.
		result.detector = "bright-pixel r+g+b>450 in x130..370,y57..107; delta>=15 px; rAF frame time"
		result.surface = await c.evaluate<string>(`__kb.kind()`)
		log(`surface ${result.surface}`)
		const latencies: number[] = []
		let misses = 0
		for (let i = 0; i < opt.samples; i++) {
			const key = i % 2 === 0 ? KEY_W : KEY_BS
			await c.evaluate(`__kb.arm()`)
			await c.send("Input.dispatchKeyEvent", {
				type: key.text ? "keyDown" : "rawKeyDown",
				key: key.key,
				code: key.code,
				windowsVirtualKeyCode: key.vk,
				text: key.text || undefined,
			})
			const r = await c.evaluate<{ keyAt: number | null; hitAt: number | null }>(`__kb.wait(2500)`)
			await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.vk })
			if (r.keyAt === null || r.hitAt === null) misses++
			else latencies.push(r.hitAt - r.keyAt)
			await sleep(300 + Math.random() * 150)
			if (i % 20 === 19) log(`latency ${i + 1}/${opt.samples} misses=${misses}`)
		}
		latencies.sort((a, b) => a - b)
		const latencySummary = {
			unit: "ms",
			n: latencies.length,
			misses,
			p50: round(percentile(latencies, 50)),
			p90: round(percentile(latencies, 90)),
			p99: round(percentile(latencies, 99)),
			min: round(latencies[0] ?? Number.NaN),
			max: round(latencies[latencies.length - 1] ?? Number.NaN),
			mean: round(latencies.reduce((s, v) => s + v, 0) / latencies.length),
		}
		result.latency = { ...latencySummary, samples: latencies.map(round) }
		log(`latency p50 ${latencySummary.p50} p90 ${latencySummary.p90} p99 ${latencySummary.p99} n=${latencySummary.n} misses=${misses}`)

		// ---- 2-4. bytes / control-plane requests / box CPU per workload
		const rootOut = await shell(opt.boxExec, ROOT_SCRIPT, [opt.boxCwd])
		const rootPid = Number(rootOut.trim().split(/\s+/)[0])
		if (!Number.isFinite(rootPid)) fail(`box process not found under ${opt.boxCwd}`)
		result.boxRootPid = rootPid

		const workloads: Record<string, WindowStats> = {}
		log("workload idle")
		workloads.idle = await measure(c, opt, counters, rootPid, "idle", () => sleep(opt.workloadSec * 1000))
		log("workload typing")
		workloads.typing = await measure(c, opt, counters, rootPid, "typing", async () => {
			const end = performance.now() + opt.workloadSec * 1000
			for (let n = 0; performance.now() < end; n++) {
				const ch = TYPING_TEXT[n % TYPING_TEXT.length] ?? " "
				await tapKey(c, { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch })
				await sleep(125)
			}
		})
		// Fill xterm scrollback first (not measured; xterm keeps 1024 lines so 1000 fits).
		// Start the fill from a fresh prompt: the typing workload leaves text on the line, so Enter runs it (harmless).
		await tapKey(c, KEY_ENTER)
		await sleep(500)
		await typeLine(c, "seq 1 1000")
		await sleep(3000)
		await saveShot(c, opt.out.replace(/\.json$/, "-seq.png"))
		// xterm ignores wheel without mouse reporting, so keyboard scrollback (Shift+PageUp/PageDown) is the
		// "scrolling" workload. Wheel is measured separately so its effect is observed, not assumed.
		// The app forwards key names, not modifier state, so Shift must go down as its own key event.
		const SHIFT = { key: "Shift", code: "ShiftLeft", vk: 16 }
		const pageKey = async (up: boolean): Promise<void> => {
			const kc = up ? { key: "PageUp", code: "PageUp", vk: 33 } : { key: "PageDown", code: "PageDown", vk: 34 }
			await c.send("Input.dispatchKeyEvent", { type: "keyDown", ...SHIFT, windowsVirtualKeyCode: SHIFT.vk })
			await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...kc, windowsVirtualKeyCode: kc.vk })
			await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...kc, windowsVirtualKeyCode: kc.vk })
			await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...SHIFT, windowsVirtualKeyCode: SHIFT.vk })
		}
		log("workload scrolling")
		workloads.scrolling = await measure(c, opt, counters, rootPid, "scrolling", async () => {
			const end = performance.now() + opt.workloadSec * 1000
			for (let n = 0; performance.now() < end; n++) {
				await pageKey(n % 2 === 0)
				await sleep(400)
			}
		})
		await saveShot(c, opt.out.replace(/\.json$/, "-scrolled.png"))
		log("workload scrolling-wheel")
		workloads["scrolling-wheel"] = await measure(c, opt, counters, rootPid, "scrolling-wheel", async () => {
			const at = await c.evaluate<{ x: number; y: number } | null>(RECT_JS)
			if (!at) fail("viewer surface disappeared")
			const end = performance.now() + opt.workloadSec * 1000
			for (let n = 0; performance.now() < end; n++) {
				// One notch per event (PIXELS_PER_NOTCH): the same content per event as main's sign-only client.
				await c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: n % 2 ? 50 : -50 })
				await sleep(100)
			}
		})
		result.workloads = workloads
	} finally {
		if (cdp) {
			await cdp.send("Page.navigate", { url: "about:blank" }).catch(() => undefined)
			cdp.close()
		}
		await api(opt.api, cookie, "DELETE", `/api/tasks/${taskId}/desktop`).catch(() => undefined)
		await api(opt.api, cookie, "POST", `/api/tasks/${taskId}/archive`).catch(() => undefined)
	}
	mkdirSync(dirname(opt.out), { recursive: true })
	writeFileSync(opt.out, JSON.stringify(result, null, 2) + "\n")
	console.log(`wrote ${opt.out}`)
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
	process.exit(1)
})

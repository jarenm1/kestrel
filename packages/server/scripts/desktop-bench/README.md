# Desktop transport bench

Compares the desktop viewer transport on `origin/main` (WebSocket, canvas) with the WebRTC branch
(`0b5740e`, video track). Measures input-to-pixel latency, bytes on the wire, decoded and rendered fps,
freezes, and box-side CPU, on loopback and over an emulated WAN (40 ms RTT, 10 ms jitter, 0/1/3% loss).

## Files

- `bench.ts`: driver. Logs in, creates a task, opens the desktop, runs latency samples and four workloads, writes JSON.
- `probe.ts`: in-page probes (surface detection, input injection, decoder freeze counter, RTC stats).
- `cdp.ts`: minimal Chrome DevTools Protocol client.
- `chrome.sh`: starts Chrome with remote debugging on a given port.
- `proxy.ts`: TCP relay. Drain-aware, so short writes are buffered and `end()` waits for drain.
- `wan.sh`: WAN condition (netem, worker container, relays, host firewall rules, proxies).
- `results/`: `<transport>-<condition>.json` per run, plus per-run screenshots written by the bench.

## Commands

Stacks (already running, not started by this bench):

- Baseline (`origin/main`, WebSocket): control `8868`, app `5253`, box `8877`.
- Branch (`0b5740e`, WebRTC): control `8808`, app `5193`, box `8817`.

The bench uses the control port as both `--api` and `--page`. Vite app pages show no Desktop tab.

Loopback (from `packages/server`):

```sh
bun run scripts/desktop-bench/bench.ts --transport ws --label ws-loopback \
  --api http://127.0.0.1:8868 --page http://127.0.0.1:8868 --cdp-port 9333 \
  --box-cwd /home/jaren/kestrel-worktrees/bench-main/packages/server \
  --samples 60 --workload-sec 30 --out scripts/desktop-bench/results/ws-loopback.json

bun run scripts/desktop-bench/bench.ts --transport webrtc --label webrtc-loopback \
  --api http://127.0.0.1:8808 --page http://127.0.0.1:8808 --cdp-port 9333 \
  --box-cwd /home/jaren/kestrel-worktrees/review-pr147/packages/server \
  --focus '(() => { const i = document.querySelector(`input[aria-label="Desktop keyboard input"]`); if (!i) return false; i.focus(); return document.activeElement === i; })()' \
  --samples 60 --workload-sec 30 --out scripts/desktop-bench/results/webrtc-loopback.json
```

WAN (from `packages/server/scripts/desktop-bench`):

```sh
./wan.sh up 0 8868 8877 8808 8817        # network, worker container + Chrome, netem, firewall, proxies, relays
./wan.sh bench --transport ws --label ws-wan-0 \
  --api http://172.31.0.1:8868 --page http://172.31.0.1:8868 --cdp-port 9333 \
  --box-cwd /home/jaren/kestrel-worktrees/bench-main/packages/server \
  --samples 60 --workload-sec 30 --out scripts/desktop-bench/results/ws-wan-0.json
./wan.sh bench --transport webrtc --label webrtc-wan-0 \
  --api http://172.31.0.1:8808 --page http://172.31.0.1:8808 --cdp-port 9333 \
  --box-cwd /home/jaren/kestrel-worktrees/review-pr147/packages/server \
  --focus '…same as loopback…' --samples 60 --workload-sec 30 --out scripts/desktop-bench/results/webrtc-wan-0.json
./wan.sh set-loss 1   # then the same two bench commands with -wan-1
./wan.sh set-loss 3   # then the same two bench commands with -wan-3
./wan.sh down         # removes netem, firewall rules, proxies, relays, container, network
```

Each full run (60 samples, 30 s workloads) takes about 165 s. Background jobs are capped at 300 s, so
runs were executed as single foreground calls.

## Methodology

- **Latency.** Each sample toggles a visible glyph (`W` and `BackSpace` alternate, 300–450 ms apart) and
  detects the change in the desktop surface. Detector: bright-pixel rule (r+g+b > 450) in x130..370,
  y57..107, change ≥ 15 px versus the count at key time. Timestamp is the page's rAF frame time, minus the
  key-event time, both on the page clock.
- **Workloads.** `idle`, `typing` (fixed text), `scrolling` (keyboard), `scrolling-wheel` (wheel), 30 s each.
- **Bytes.** Per workload, normalised to per-minute. `total` = `wsRx + wsTx + rtcRx + rtcTx` (every byte the browser
  moved on the desktop path). `videoRx` and `audioRx` are inbound RTP bytes for the WebRTC tracks (subsets of `rtcRx`).
  WebSocket runs report `wsRx` only, so their video/audio columns are 0 by construction.
- **fps.** WebSocket: `VideoDecoder` output (decoded) and canvas draw (rendered). WebRTC: inbound-rtp
  `framesDecoded` (the `<video>` presents every decoded frame, so rendered = decoded).
- **Freezes.** Same rule on both transports for the gap between frames: gap ≥ max(3·avg, avg + 150 ms), with
  EWMA avg (alpha 0.1). WebSocket uses the in-page decoder gap. WebRTC uses Chrome's `freezeCount` from
  inbound-rtp, which uses its own definition and may differ at the edges. The gap counter is reset before
  each window, so idle time before a window is never counted as a freeze.
- **Box CPU.** `/proc/<pid>/stat` utime+stime deltas over each window, for the box root process
  (`src/main.ts`) and its child groups (`ffmpeg`, `xdamage`, other desktop children). Reported as cores.

## WAN setup

- Worker container `kbench-worker` (`ubuntu:24.04`, IP `172.31.0.40`) on bridge `kbench0`, gateway `172.31.0.1`.
  Chrome and the bench driver run inside the container.
- `netem`: `delay 20ms 10ms` on both hops (container egress and bridge egress), so RTT is about 40 ms with
  10 ms jitter per hop. Loss X% applies per hop, so each direction loses about X%.
- Host proxies (`proxy.ts`) bind `172.31.0.1:<port>` and forward to `127.0.0.1:<port>`, for the control and box ports.
- The app calls the box at `http://127.0.0.1:<box port>` (`/api/tasks`, `/api/webrtc/offer`, `/api/events`), so
  each port also has an in-container relay `127.0.0.1:<port>` → `172.31.0.1:<port>`. Without the relay the
  WebRTC offer never reaches the box.
- Host NixOS firewall: `wan.sh up` inserts ACCEPT rules at the top of `nixos-fw`, scoped to source `172.31.0.40` on
  `kbench0`: TCP to each proxied port, plus all UDP from that source (WebRTC ICE). `wan.sh down` removes exactly those rules.
- Chrome in the container runs with `--unsafely-treat-insecure-origin-as-secure=http://172.31.0.1:<port>,…`.
  Without it, Chrome drops the `Secure` dev-login cookie over plain HTTP on a non-localhost IP. WAN only.
- The bench driver runs as root in the container (`docker exec -u 0`) with `SYS_PTRACE`. Uid 1000 cannot read
  `/proc/<box>/cwd`, so box CPU would silently be empty. `wan.sh` chowns `results/` back to 1000:1000 afterwards.

## Proxy fix

The original `proxy.ts` wrote chunks without checking the return value. Bun's `socket.write()` returns the number
of bytes sent and buffers the rest, and `end()` then drops the buffered tail. Repro: an 8 MB write delivered
2,634,240 bytes. Under 20 ms netem this truncated the 1,367,127-byte `index-*.js` bundle, so the page failed
to load. The fixed proxy copies each chunk, sets `buffered` when `write()` returns short, and defers `end()` until
drain. This applies to every WAN run, WebSocket and WebRTC alike.

## Caveats

- One run per cell. Latency percentiles use n = 60, so p99 is effectively the second-largest sample. The
  WAN 3% p99 outliers (WebSocket 360.7 ms, WebRTC 1103 ms) are single samples.
- Loopback runs use Chrome on the host. WAN runs use Chrome in the container. The page origin differs
  (`127.0.0.1` vs `172.31.0.1`), so cross-origin and secure-context behaviour differ between the two.
- WebRTC numbers were measured on branch commit `0b5740e`. The `review-pr147` worktree now reports HEAD `283de1b`;
  these results do not cover any later commits. Re-run the WebRTC cells after that change lands before drawing conclusions.
- WebSocket bytes are a single `wsRx` counter. The video/audio split (zero in the WebSocket rows) does not
  apply to that transport.
- WebSocket idle shows 0 decoded fps; its ~29 WS frames per window are non-video. WebRTC idle shows about 1 fps
  (a low-rate video stream). Freeze counts at 1 fps depend on the gap threshold.
- Box CPU is consistent across repeated sampling but not validated against an independent meter. WebRTC WAN idle
  CPU (0.27–0.28 cores) is higher than WebRTC loopback idle (0.10 cores). The cause is not isolated.
- During the WAN WebRTC run, the app's `/api/events` WebSocket to the box returned `HTTP Authentication failed`
  (observed in CDP Network events). It did not affect the desktop path, and the cause was not investigated.

## Results

Latency in milliseconds, 60 samples per run. Bytes per minute. CPU in cores, summed over box process groups.

### Latency

| run | surface | n | misses | p50 | p90 | p99 | max |
|---|---|---|---|---|---|---|---|
| ws-loopback | CANVAS | 60 | 0 | 41.5 | 48.9 | 50.8 | 50.8 |
| webrtc-loopback | VIDEO | 60 | 0 | 18.9 | 24.9 | 33.0 | 33.0 |
| ws-wan-0 | CANVAS | 60 | 0 | 78.2 | 90.5 | 100.3 | 100.3 |
| webrtc-wan-0 | VIDEO | 60 | 0 | 64.1 | 72.4 | 83.8 | 83.8 |
| ws-wan-1 | CANVAS | 60 | 0 | 79.4 | 91.5 | 96.9 | 96.9 |
| webrtc-wan-1 | VIDEO | 60 | 0 | 63.0 | 76.2 | 102.1 | 102.1 |
| ws-wan-3 | CANVAS | 60 | 0 | 79.7 | 98.4 | 360.7 | 360.7 |
| webrtc-wan-3 | VIDEO | 60 | 0 | 64.0 | 76.1 | 1103.0 | 1103.0 |

### Workloads

| run | workload | video B/min | audio B/min | total B/min | fps dec/rend | freezes (ms) | CPU cores |
|---|---|---|---|---|---|---|---|
| ws-loopback | idle | 0 | 0 | 11808 | 0.0/0.0 | 0 (0) | 0.009 |
| ws-loopback | typing | 0 | 0 | 234703 | 6.3/6.3 | 0 (0) | 0.237 |
| ws-loopback | scrolling | 0 | 0 | 85836 | 2.5/2.5 | 2 (803) | 0.087 |
| ws-loopback | scrolling-wheel | 0 | 0 | 234785 | 8.5/8.5 | 0 (0) | 0.262 |
| webrtc-loopback | idle | 7580 | 4090 | 62831 | 1.0/1.0 | 0 (0) | 0.097 |
| webrtc-loopback | typing | 144893 | 4146 | 269175 | 6.3/6.3 | 0 (0) | 0.145 |
| webrtc-loopback | scrolling | 81801 | 4088 | 247710 | 2.5/2.5 | 1 (1010) | 0.122 |
| webrtc-loopback | scrolling-wheel | 910512 | 4118 | 1081861 | 10.0/10.0 | 0 (0) | 0.211 |
| ws-wan-0 | idle | 0 | 0 | 11761 | 0.0/0.0 | 0 (0) | 0.009 |
| ws-wan-0 | typing | 0 | 0 | 235113 | 6.3/6.3 | 0 (0) | 0.202 |
| ws-wan-0 | scrolling | 0 | 0 | 85621 | 2.5/2.5 | 2 (792) | 0.085 |
| ws-wan-0 | scrolling-wheel | 0 | 0 | 268923 | 8.5/8.5 | 0 (0) | 0.261 |
| webrtc-wan-0 | idle | 7559 | 4079 | 64813 | 1.0/1.0 | 0 (0) | 0.276 |
| webrtc-wan-0 | typing | 144953 | 4134 | 327784 | 6.3/6.3 | 0 (0) | 0.323 |
| webrtc-wan-0 | scrolling | 78973 | 4128 | 299011 | 2.5/2.5 | 1 (1024) | 0.376 |
| webrtc-wan-0 | scrolling-wheel | 910834 | 4079 | 1590852 | 10.0/10.0 | 0 (0) | 0.363 |
| ws-wan-1 | idle | 0 | 0 | 11727 | 0.0/0.0 | 0 (0) | 0.009 |
| ws-wan-1 | typing | 0 | 0 | 235130 | 6.3/6.2 | 0 (0) | 0.201 |
| ws-wan-1 | scrolling | 0 | 0 | 85566 | 2.5/2.5 | 2 (785) | 0.085 |
| ws-wan-1 | scrolling-wheel | 0 | 0 | 277958 | 8.5/8.4 | 0 (0) | 0.261 |
| webrtc-wan-1 | idle | 7556 | 4132 | 65326 | 1.0/1.0 | 0 (0) | 0.272 |
| webrtc-wan-1 | typing | 144751 | 4053 | 323281 | 6.2/6.2 | 1 (560) | 0.326 |
| webrtc-wan-1 | scrolling | 79079 | 3998 | 303795 | 2.5/2.5 | 1 (974) | 0.302 |
| webrtc-wan-1 | scrolling-wheel | 909446 | 4047 | 1598801 | 10.0/10.0 | 0 (0) | 0.422 |
| ws-wan-3 | idle | 0 | 0 | 12122 | 0.0/0.0 | 0 (0) | 0.008 |
| ws-wan-3 | typing | 0 | 0 | 234630 | 6.3/6.2 | 0 (0) | 0.201 |
| ws-wan-3 | scrolling | 0 | 0 | 85600 | 2.5/2.5 | 2 (1181) | 0.086 |
| ws-wan-3 | scrolling-wheel | 0 | 0 | 234665 | 8.5/8.2 | 3 (1337) | 0.261 |
| webrtc-wan-3 | idle | 7809 | 4052 | 67931 | 1.0/1.0 | 1 (2047) | 0.274 |
| webrtc-wan-3 | typing | 143624 | 4028 | 324599 | 6.2/6.2 | 2 (1146) | 0.324 |
| webrtc-wan-3 | scrolling | 79296 | 3992 | 296429 | 2.5/2.5 | 1 (1003) | 0.290 |
| webrtc-wan-3 | scrolling-wheel | 910625 | 3909 | 1540778 | 10.0/10.0 | 0 (0) | 0.385 |

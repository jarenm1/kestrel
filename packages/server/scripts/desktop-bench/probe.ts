// In-page helpers injected into the viewer tab. Everything runs in the page so timestamps share one clock
// (the page's performance.now / rAF timestamps) and no cross-machine clock sync is needed.
//
// Detector (same as local://latency-probe.md, used for BOTH transports): count bright pixels (r+g+b > 450) in the
// fixed region x130..370, y57..107 of the 1920x1080 frame; a change of at least 15 pixels versus the count taken
// when the key was sent counts as "visible". Sampled every requestAnimationFrame; timestamp = rAF frame time.
// Surface = <video> (branch) or <canvas> (baseline); both are read through drawImage into a scratch canvas.

/** Installed before any page script runs: remembers every RTCPeerConnection (byte counters) and counts frames:
 *  VideoDecoder output = decoded; canvas drawImage of a VideoFrame = rendered (WS baseline path). */
export const INIT_JS = `(() => {
  if (window.__pcs) return;
  window.__pcs = [];
  const P = window.RTCPeerConnection;
  if (P) window.RTCPeerConnection = new Proxy(P, {
    construct(target, args) { const pc = Reflect.construct(target, args); window.__pcs.push(pc); return pc; },
  });
  window.__frames = { decoded: 0, drawn: 0, freezes: 0, freezeMs: 0, last: null, avg: 0 };
  // Same freeze rule as WebRTC inbound-rtp freezeCount: a decoded-frame gap >= max(3*avg, avg+150 ms).
  const noteFrame = () => {
    const f = window.__frames, now = performance.now();
    if (f.last !== null) {
      const gap = now - f.last, avg = f.avg || gap;
      if (gap >= Math.max(3 * avg, avg + 150)) { f.freezes++; f.freezeMs += gap; }
      f.avg = avg * 0.9 + gap * 0.1;
    }
    f.last = now;
  };
  const VD = window.VideoDecoder;
  if (VD) window.VideoDecoder = class extends VD {
    constructor(init) { super({ output: (f) => { window.__frames.decoded++; noteFrame(); init.output(f); }, error: init.error }); }
  };
  const di = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (img) {
    if (typeof VideoFrame !== 'undefined' && img instanceof VideoFrame) window.__frames.drawn++;
    return di.apply(this, arguments);
  };
})();`;

/** Defines window.__kb. Idempotent. Promise-returning helpers reject on page-side errors instead of hanging. */
export const PROBE_JS = `(() => {
  if (window.__kb) return true;
  const kb = {};
  window.__kb = kb;
  kb.region = { x: 130, y: 57, w: 240, h: 50 };
  kb.bright = 450;
  kb.delta = 15;
  kb.armed = false;
  kb.keyAt = null;
  kb.ref = 0;
  kb.scratch = document.createElement('canvas');
  kb.scratch.width = kb.region.w;
  kb.scratch.height = kb.region.h;
  kb.sctx = kb.scratch.getContext('2d', { willReadFrequently: true });
  kb.surface = () => {
    const v = document.querySelector('video');
    if (v && v.videoWidth > 0) return v;
    return document.querySelector('canvas[tabindex="0"]') || document.querySelector('canvas');
  };
  kb.kind = () => { const s = kb.surface(); return s ? s.tagName : null; };
  kb.count = () => {
    const s = kb.surface();
    if (!s) throw new Error('no viewer surface');
    const { x, y, w, h } = kb.region;
    kb.sctx.drawImage(s, x, y, w, h, 0, 0, w, h);
    const d = kb.sctx.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > kb.bright) n++;
    return n;
  };
  // Call immediately before dispatching the key. Records the reference count.
  kb.arm = () => {
    kb.keyAt = null;
    kb.ref = kb.count();
    kb.armed = true;
    return kb.ref;
  };
  // Resolves with {keyAt, hitAt, count}; hitAt is the rAF frame time of the first changed frame, null on timeout.
  kb.wait = (timeoutMs) => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const step = (t) => {
      try {
        if (kb.keyAt !== null && Math.abs(kb.count() - kb.ref) >= kb.delta) {
          kb.armed = false;
          return resolve({ keyAt: kb.keyAt, hitAt: t, ref: kb.ref });
        }
        if (performance.now() - t0 > timeoutMs) { kb.armed = false; return resolve({ keyAt: kb.keyAt, hitAt: null, ref: kb.ref }); }
        requestAnimationFrame(step);
      } catch (e) { kb.armed = false; reject(e); }
    };
    requestAnimationFrame(step);
  });
  window.addEventListener('keydown', () => { if (kb.armed && kb.keyAt === null) kb.keyAt = performance.now(); }, true);
  kb.rtcBytes = async () => {
    const out = { rx: 0, tx: 0, videoRx: 0, audioRx: 0, videoFrames: 0, audioPackets: 0, freezeCount: 0, freezeMs: 0, apiRx: 0, apiTx: 0, dcRx: 0, dcTx: 0, keyFrames: 0, pli: 0, fir: 0, nack: 0 };
    // Desktop media PC = the one with a video receiver; every other PC (the kestrel-api channel) is counted as API.
    for (const pc of window.__pcs || []) {
      const media = pc.getReceivers().some((r) => r.track && r.track.kind === 'video');
      const st = await pc.getStats();
      let rx = 0, tx = 0, dcRx = 0, dcTx = 0;
      st.forEach((r) => {
        if (r.type === 'transport') { rx += r.bytesReceived || 0; tx += r.bytesSent || 0; }
        if (r.type === 'data-channel') { dcRx += r.bytesReceived || 0; dcTx += r.bytesSent || 0; }
        if (r.type === 'inbound-rtp') {
          const kind = r.kind || r.mediaType;
          const wire = (r.bytesReceived || 0) + (r.headerBytesReceived || 0);
          if (kind === 'video') { out.videoRx += wire; out.videoFrames += r.framesDecoded || 0; out.freezeCount += r.freezeCount || 0; out.freezeMs += (r.totalFreezesDuration || 0) * 1000; out.keyFrames += r.keyFramesDecoded || 0; out.pli += r.pliCount || 0; out.fir += r.firCount || 0; out.nack += r.nackCount || 0; }
          else if (kind === 'audio') { out.audioRx += wire; out.audioPackets += r.packetsReceived || 0; }
        }
      });
      if (media) { out.rx += rx; out.tx += tx; out.dcRx += dcRx; out.dcTx += dcTx; }
      else { out.apiRx += rx; out.apiTx += tx; }
    }
    return out;
  };
  return true;
})()`

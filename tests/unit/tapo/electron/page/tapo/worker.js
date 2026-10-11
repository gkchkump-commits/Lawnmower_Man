// The harness security worker: speaks the main ↔ worker protocol of contract §9.3 on the
// MessagePort from main (hello → ready, config → VideoDecoder.configure, chunk → decode,
// snap → JPEG of the last frame, stats every second) and sends det messages on command.
/* global self, VideoDecoder, EncodedVideoChunk, OffscreenCanvas, createImageBitmap */

/** @type {MessagePort|null} */
let port = null;
/** @type {VideoDecoder|null} */
let decoder = null;
/** @type {VideoFrame|null} */
let last = null;
let frames = 0;
let lastSecFrames = 0;
let needKey = true;
let gen = -1;

const post = (m, t) => port && port.postMessage(m, t || []);
const werr = (message) => self.postMessage({ t: 'werr', message: String(message) });

function closeDecoder() {
  try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch { /* closed */ }
  decoder = null;
  needKey = true;
}

/** @param {any} m */
async function configure(m) {
  closeDecoder();
  gen = m.gen;
  const config = { codec: m.codec, description: m.description, codedWidth: m.width, codedHeight: m.height, optimizeForLatency: true };
  let support = { supported: false };
  try {
    support = await VideoDecoder.isConfigSupported(config);
  } catch (err) {
    werr(err);
  }
  self.postMessage({ t: 'decoder', info: { codec: m.codec, supported: !!support.supported } });
  if (!support.supported) {
    post({ t: 'error', fatal: true, message: `cannot decode ${m.codec}` });
    return;
  }
  decoder = new VideoDecoder({
    output: (f) => {
      frames++;
      lastSecFrames++;
      if (last) last.close();
      last = f;
      if (frames % 3 === 1) {
        createImageBitmap(f).then((b) => self.postMessage({ t: 'frame', n: frames, bitmap: b }, [b]), werr);
      }
    },
    error: (e) => {
      werr(e);
      post({ t: 'error', fatal: false, message: String(e.message || e) });
      needKey = true;
    },
  });
  decoder.configure(config);
}

/** @param {any} m */
async function snap(m) {
  if (!last) {
    post({ t: 'snap-err', id: m.id, message: 'No decoded frame yet.' });
    return;
  }
  const scale = Math.min(1, (m.maxSide || 640) / Math.max(last.displayWidth, last.displayHeight));
  const w = Math.max(1, Math.round(last.displayWidth * scale));
  const hgt = Math.max(1, Math.round(last.displayHeight * scale));
  const c = new OffscreenCanvas(w, hgt);
  c.getContext('2d').drawImage(last, 0, 0, w, hgt);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: m.quality || 0.8 });
  const ab = await blob.arrayBuffer();
  // copied, not transferred: Electron's MessagePortMain takes only MessagePorts as transferables
  // (a transferred ArrayBuffer does not arrive in main as sent; see the xfer-probe check)
  post({ t: 'snap-ok', id: m.id, jpeg: ab, width: w, height: hgt, frameTs: last.timestamp });
}

/** @param {MessageEvent} e */
function onMain(e) {
  const m = e.data;
  switch (m.t) {
    case 'hello':
      post({ t: 'ready', detector: 'stub' });
      break;
    case 'config':
      configure(m).catch(werr);
      break;
    case 'chunk':
      if (!decoder || decoder.state !== 'configured' || m.gen !== gen) return;
      if (needKey && !m.key) return;
      needKey = false;
      try {
        decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts, duration: m.dur, data: m.data }));
      } catch (err) {
        werr(err);
        needKey = true;
      }
      break;
    case 'idle':
      closeDecoder();
      break;
    case 'snap':
      snap(m).catch((err) => post({ t: 'snap-err', id: m.id, message: String(err) }));
      break;
    default:
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'port') {
    if (port) port.close();
    port = e.ports[0];
    port.onmessage = onMain;
    port.start();
  } else if (m.t === 'xfer-probe') {
    // the same small message, once with the ArrayBuffer transferred and once copied
    const a = new ArrayBuffer(8);
    try {
      post({ t: 'error', fatal: false, message: 'xfer-probe transferred', bytes: a }, [a]);
    } catch (err) {
      werr(`transfer threw: ${err}`);
    }
    post({ t: 'error', fatal: false, message: 'xfer-probe copied', bytes: new ArrayBuffer(8) });
  } else if (m.t === 'det-cmd') {
    const at = Date.now();
    post({ t: 'det', at, frameTs: last ? last.timestamp : 0, motion: { active: m.person, score: m.person ? 0.05 : 0, global: false }, persons: m.person ? [{ score: 0.9, box: [0.4, 0.3, 0.15, 0.4] }] : [] });
  }
};

setInterval(() => {
  post({ t: 'stats', fps: lastSecFrames, decodeQueue: decoder ? decoder.decodeQueueSize : 0, dropped: 0, decoder: 'no-preference', configSupported: true });
  lastSecFrames = 0;
}, 1000);

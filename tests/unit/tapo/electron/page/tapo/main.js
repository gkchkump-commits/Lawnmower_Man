// The harness camera page: what lane B's page does with the bridge, reduced to the contract
// (§6.2, §9.3): accept the worker port from the preload (window.postMessage, same window only),
// hand it to a module worker, request it, report the view visible, and draw decoded frames.
// window.__harness is read by harness-main.mjs through executeJavaScript.
/* global Worker */

const cam = window.lawnmowerCamera;
const h = {
  api: cam ? Object.keys(cam).sort() : null,
  tapoApi: cam ? Object.keys(cam.tapo).sort() : null,
  types: { require: typeof window.require, process: typeof window.process, lawnmower: typeof window.lawnmower, ipcRenderer: typeof window.ipcRenderer },
  ports: 0,
  frames: 0,
  workerErrors: [],
  status: '',
  boot: Date.now(),
};
window.__harness = h;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const ctx = canvas.getContext('2d');
const footer = document.getElementById('status');
const show = () => { footer.textContent = `connection: ${h.status || '…'} · port ${h.ports} · frames decoded: ${h.frames}`; };

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'frame') {
    h.frames = m.n;
    if (canvas.width !== m.bitmap.width) {
      canvas.width = m.bitmap.width;
      canvas.height = m.bitmap.height;
    }
    ctx.drawImage(m.bitmap, 0, 0);
    m.bitmap.close();
    show();
  } else if (m.t === 'werr') h.workerErrors.push(m.message);
  else if (m.t === 'decoder') h.decoder = m.info;
};
worker.onerror = (e) => h.workerErrors.push(String(e.message || e));

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.type !== 'lm:tapo:port' || !ev.ports?.[0]) return;
  h.ports++;
  worker.postMessage({ t: 'port' }, [ev.ports[0]]);
  show();
});

cam.tapo.onStatus((s) => { h.status = s.connection; show(); });

/** harness commands */
h.det = (person) => worker.postMessage({ t: 'det-cmd', person: !!person });
h.xferProbe = () => worker.postMessage({ t: 'xfer-probe' });
h.ptz = (cmd) => cam.tapo.ptz(cmd);
h.fetchRange = async (url, range) => {
  const r = await fetch(url, { headers: range ? { Range: range } : {} });
  const b = await r.arrayBuffer();
  return { status: r.status, contentRange: r.headers.get('content-range'), type: r.headers.get('content-type'), length: b.byteLength, head: Array.from(new Uint8Array(b.slice(4, 8))).map((c) => String.fromCharCode(c)).join('') };
};
h.playClip = (url) => new Promise((resolve) => {
  const v = document.createElement('video');
  v.muted = true;
  const done = (r) => { resolve(r); v.remove(); };
  v.onloadeddata = () => done({ ok: true, width: v.videoWidth, height: v.videoHeight, duration: v.duration, readyState: v.readyState });
  v.onerror = () => done({ ok: false, error: v.error ? `${v.error.code} ${v.error.message}` : 'error' });
  setTimeout(() => done({ ok: false, error: 'timeout', readyState: v.readyState }), 8000);
  v.src = url;
  document.body.appendChild(v);
});
h.otherGroup = () => cam.settings.set({ voice: { engine: 'piper' } }).then(() => 'accepted', (e) => `rejected: ${e.message}`);
h.cameraGroup = () => cam.settings.set({ tapo: { name: 'harness porch' } }).then(() => 'accepted', (e) => `rejected: ${e.message}`);

show();
cam.tapo.requestPort().then((r) => { h.requested = r; });
cam.tapo.setViewVisible(true);

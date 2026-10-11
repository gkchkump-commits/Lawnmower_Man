// The "Jade wake word" utility process (Electron utilityProcess; contract-wake §7.3). It loads the
// vendored sherpa-onnx addon, runs stage 1 of "Hey Jade" on the 16 kHz audio the avatar window
// posts over a direct MessagePort, and posts hits back on that port. No network, no file writes:
// it reads its model files and talks only to its parent (main) and the renderer port.
//
// parentPort (main ↔ utility):
//   main → u  { t:'init', addon, models: { zhen?, giga, vad }, params: { sensitivity, phrase }, config }
//             { t:'port', gen } + port      { t:'settings', params }      { t:'ping', n }      { t:'stop' }
//   u → main  { t:'ready', models, loadMs }   { t:'error', fatal, message }   { t:'stats', …, hits }   { t:'pong', n }
// The renderer port: utility/protocol.js.

import './lockdown.js'; // first: no network or process modules from here on (§2.3)
import { loadAddon } from './sherpa.js';
import { WakeEngine } from './engine.js';
import { PortSession } from './protocol.js';

const STATS_MS = 10000;
const parent = /** @type {any} */ (process).parentPort;
if (!parent) {
  console.error('electron/wake/utility/main.js runs in an Electron utilityProcess');
  process.exit(2);
}

/** @type {WakeEngine|null} */
let engine = null;
/** @type {PortSession|null} */
let session = null;
/** @type {any} */
let port = null;
/** @type {{ port: any, gen: number }|null} */
let waiting = null;
/** @type {NodeJS.Timeout|null} */
let statsTimer = null;
let stopping = false;

/** @param {any} m */
function send(m) {
  try {
    parent.postMessage(m);
  } catch { /* main is gone */ }
}

/** @param {any} m */
function toPort(m) {
  try {
    port?.postMessage(m);
  } catch { /* the renderer went away; it asks for a new port */ }
}

/** @param {unknown} err */
function fatal(err) {
  const message = err instanceof Error ? err.message : String(err);
  send({ t: 'error', fatal: true, message: message.slice(0, 500) });
  setTimeout(() => process.exit(1), 50);
}

function stats() {
  if (!engine) return;
  const st = { t: 'stats', ...engine.stats() };
  toPort(st);
  send({ ...st, hits: engine.recent.map((h) => ({ id: h.id, keyword: h.keyword, model: h.model, streamAt: h.streamAt, startAt: h.startAt, endAt: h.endAt, emitAt: h.emitAt })) });
}

/** @param {any} m */
function init(m) {
  if (engine) return;
  try {
    const addon = loadAddon(String(m.addon));
    const models = { giga: m.models.giga, vad: String(m.models.vad), zhen: m.models.zhen || null };
    engine = new WakeEngine({ addon, models, params: m.params || {}, log: (level, msg) => (level === 'error' ? console.error(msg) : console.log(msg)) });
    const r = engine.load();
    send({ t: 'ready', models: r.models, loadMs: r.loadMs });
    statsTimer = setInterval(stats, STATS_MS);
    if (waiting) {
      const w = waiting;
      waiting = null;
      attach(w.port, w.gen);
    }
  } catch (err) {
    fatal(err);
  }
}

/** @param {any} p @param {number} gen */
function attach(p, gen) {
  if (!p) return;
  if (!engine) {
    try { waiting?.port.close(); } catch { /* closed */ }
    waiting = { port: p, gen };
    return;
  }
  try { port?.close(); } catch { /* closed */ }
  port = p;
  const s = new PortSession({ engine, gen, onHits: () => stats() });
  session = s;
  p.on('message', (/** @type {any} */ ev) => {
    if (session !== s) return; // an old port
    let replies;
    try {
      replies = s.handle(ev.data);
    } catch (err) {
      engine?.noteDropped();
      replies = [{ t: 'error', message: `frame failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }];
    }
    for (const r of replies) toPort(r);
  });
  p.on('close', () => {
    if (port === p) {
      port = null;
      session = null;
    }
  });
  p.start();
  toPort(s.ready());
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (statsTimer) clearInterval(statsTimer);
  try { port?.close(); } catch { /* closed */ }
  process.exit(0);
}

parent.on('message', (/** @type {any} */ e) => {
  const m = e?.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'init') init(m);
  else if (m.t === 'port') attach(e.ports?.[0], Number(m.gen) || 0);
  else if (m.t === 'settings') engine?.setParams(m.params || {});
  else if (m.t === 'ping') send({ t: 'pong', n: Number(m.n) || 0 }); // main's liveness check
  else if (m.t === 'stop') stop();
});

process.on('uncaughtException', (err) => fatal(err));
process.on('unhandledRejection', (err) => fatal(err));
